// One-shot, manual (user-approved 2026-09-28): queue items whose product was collected but which the old settlement
// rule marked Review (any per-image Review flipped the whole product; fixed in 8d1d989). Changes only the queue state;
// nothing is fetched and no formula is touched. Each item is re-verified inside the transaction: its latest attempt's
// product workflow completed as `collected` and collected_product holds that operation with the same record hash.
// Run from the git clone: node apps/v3-workers/scripts/fix-collected-review-status-20260928.mjs [--apply]
// Without --apply it only reports. The prior state of every changed row is written to manual-releases first.
import fs from 'node:fs'; import { createRequire } from 'node:module';
const pg = createRequire(import.meta.url)('pg');
const root = '/Users/server/apps/crawler-v3', out = root + '/manual-releases/main-20260928/status-fix', apply = process.argv.includes('--apply');
const m = JSON.parse(fs.readFileSync(root + '/live/deployment.json', 'utf8'));
const db = new pg.Client({ connectionString: m.database.connectionString }); await db.connect();
try {
  await db.query('BEGIN');
  const rows = (await db.query(`SELECT i.item_id,i.state,i.attempt,i.request_id,i.updated_at,i.input->'entries'->0->'entry'->>'listingId' asin,a.proof
    FROM amazon_queue_item i JOIN amazon_queue_attempt a ON a.request_id=i.request_id WHERE i.state='review' FOR UPDATE OF i`)).rows;
  const candidates = [];
  for (const r of rows) {
    const p = (r.proof?.trees ?? []).filter(n => n.type === 'AmazonCatalogProductWorkflow');
    if (p.length === 1 && p[0].status === 'COMPLETED' && p[0].result?.status === 'collected') candidates.push({ ...r, op: p[0].result.operationId, hash: p[0].result.recordHash });
  }
  const saved = new Map((await db.query('SELECT operation_id,record_hash FROM collected_product WHERE operation_id=ANY($1)', [candidates.map(c => c.op)])).rows.map(s => [s.operation_id, s.record_hash]));
  const verified = candidates.filter(c => saved.get(c.op) === c.hash), rejected = candidates.filter(c => saved.get(c.op) !== c.hash);
  const report = { reviewItems: rows.length, collected: candidates.length, verified: verified.length, rejected: rejected.map(c => c.asin) };
  if (!apply) { await db.query('ROLLBACK'); console.log(JSON.stringify({ ...report, applied: false })); process.exit(0); }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  fs.writeFileSync(out + '/before.json', JSON.stringify(verified.map(({ proof, ...r }) => r)), { flag: 'wx', mode: 0o600 });
  const u = await db.query("UPDATE amazon_queue_item SET state='completed',updated_at=clock_timestamp() WHERE item_id=ANY($1) AND state='review'", [verified.map(c => c.item_id)]);
  if (u.rowCount !== verified.length) throw Error(`expected ${verified.length} rows, update touched ${u.rowCount}`);
  await db.query('COMMIT');
  console.log(JSON.stringify({ ...report, applied: true, changed: u.rowCount, backup: out + '/before.json' }));
} catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; } finally { await db.end(); }
