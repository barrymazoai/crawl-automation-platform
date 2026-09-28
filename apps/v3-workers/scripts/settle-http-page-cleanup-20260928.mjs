// One-shot, manual (user-approved 2026-09-28). Queue items stuck `running` with QUEUE.PAGE_CLEANUP_REQUIRED because
// closeAmazonProductPage failed (it re-verified the job through R2 first; an R2 outage failed the close too). On the
// ScraperAPI route no browser page is ever opened, so there is nothing to clean up. For each such item this checks:
//   - capture mode is scraperapi (no browser page can exist),
//   - every workflow in the request's tree is closed with no pending activity,
//   - no unreleased resource permit mentions the request or any of its workflows,
// then settles the attempt as a Review exactly as AmazonQueue.settle does, recording why in the proof.
// No business step is retried. Run from the git clone:
//   node apps/v3-workers/scripts/settle-http-page-cleanup-20260928.mjs [--apply]
import fs from 'node:fs';
import pg from 'pg';
import { Client, Connection } from '@temporalio/client';
const root = '/Users/server/apps/crawler-v3', apply = process.argv.includes('--apply');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const health = read(root + '/manual-releases/local-temporal-20260923/health.private.json');
const queueConfig = read(root + '/manual-releases/local-temporal-20260923/queue.private.json');
if (read(queueConfig.amazonConfigFile).capture?.mode !== 'scraperapi') throw Error('capture mode is not scraperapi: a browser page may exist');
const m = read(root + '/live/deployment.json');
const db = new pg.Client({ connectionString: m.database.connectionString }); await db.connect();
const c = read(health.connectionFile), t = c.transport;
const connection = await Connection.connect({ address: c.address, connectTimeout: '15 seconds', tls: { serverNameOverride: t.serverName,
  serverRootCACertificate: fs.readFileSync(t.caFile), clientCertPair: { crt: fs.readFileSync(t.certFile), key: fs.readFileSync(t.keyFile) } } });
const client = new Client({ connection, namespace: health.namespace });
// The queue's own root is the brand collection workflow of the request; children are found from each history.
async function tree(workflowId, runId, out = []) {
  const handle = client.workflow.getHandle(workflowId, runId), d = await handle.describe();
  out.push({ workflowId, runId: d.runId, type: d.type, status: d.status.name, pending: d.raw.pendingActivities?.length ?? 0 });
  for (const e of (await handle.fetchHistory()).events ?? []) {
    const child = e.childWorkflowExecutionStartedEventAttributes?.workflowExecution;
    if (child?.workflowId) await tree(child.workflowId, child.runId, out);
  }
  return out;
}
try {
  const items = (await db.query(`SELECT item_id,request_id,input->'entries'->0->'entry'->>'listingId' asin FROM amazon_queue_item
    WHERE state='running' AND last_error='QUEUE.PAGE_CLEANUP_REQUIRED'`)).rows;
  const results = [];
  for (const item of items) {
    const nodes = await tree(`v3-collection-${item.request_id}`);
    const open = nodes.filter(n => n.status === 'RUNNING' || n.pending);
    const held = (await db.query('SELECT permit_id FROM resource_permit WHERE released_at IS NULL AND (request::text LIKE $1 OR request::text LIKE ANY($2))',
      ['%' + item.request_id + '%', nodes.map(n => '%' + n.workflowId + '%')])).rows.map(r => r.permit_id);
    const ok = !open.length && !held.length;
    results.push({ asin: item.asin, requestId: item.request_id, nodes: nodes.map(n => `${n.type}:${n.status}`), open: open.length, held, settle: ok && apply });
    if (!ok || !apply) continue;
    const proof = { kind: 'manual-http-page-cleanup', requestId: item.request_id, captureMode: 'scraperapi', pageCleanup: 'no-browser-page',
      reason: 'closeAmazonProductPage failed before its HTTP not-opened branch (job verification needs R2); no page exists on the ScraperAPI route',
      trees: nodes, heldPermits: 0, settledBy: 'apps/v3-workers/scripts/settle-http-page-cleanup-20260928.mjs', at: new Date().toISOString() };
    await db.query('BEGIN');
    try {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('amazon-queue-attempt:' || $1,0))", [item.request_id]);
      const a = await db.query(`UPDATE amazon_queue_attempt SET outcome='review',proof=$2,settled_at=clock_timestamp() WHERE request_id=$1 AND outcome='running'`, [item.request_id, proof]);
      const i = await db.query(`UPDATE amazon_queue_item SET state='review',last_error=NULL,updated_at=clock_timestamp(),next_check_at=clock_timestamp()
        WHERE item_id=$1 AND request_id=$2 AND state='running' AND last_error='QUEUE.PAGE_CLEANUP_REQUIRED'`, [item.item_id, item.request_id]);
      if (a.rowCount !== 1 || i.rowCount !== 1) throw Error(`settle conflict for ${item.asin}`);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; }
  }
  console.log(JSON.stringify({ applied: apply, items: results }, null, 1));
} finally { await connection.close(); await db.end(); }
