import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { Connection, Client, WorkflowIdReusePolicy } from '@temporalio/client';
import { artifactBuildId } from '@crawl-automation/v3-worker-runtime';
import { entryConfig, temporalOptions } from './config.js';
import { BrandEntryLedger } from './ledger.js';
import { BrowserRunner } from './browser-runner.js';
import { CONTROL_QUEUE, CallSchema } from './contracts.js';

async function main() {
  const [command, configFile, ...args] = process.argv.slice(2), root = dirname(fileURLToPath(import.meta.url));
  if (command === 'build-id') { console.log(await artifactBuildId((await fs.readdir(root)).filter(n => n.endsWith('.js') || n.endsWith('.cjs')).sort().map(n => join(root, n)))); return; }
  if (!configFile) throw Error('BRAND_ENTRY.CONFIG_REQUIRED');
  const config = await entryConfig(configFile);
  if (command === 'start' || command === 'temporal-check') {
    const t = await temporalOptions(config.temporalConfigFile), connection = await Connection.connect({ address: t.address, tls: t.tls, connectTimeout: '15 seconds' });
    try {
      const client = new Client({ connection, namespace: t.namespace });
      if (command === 'temporal-check') { const n = await connection.workflowService.describeNamespace({ namespace: t.namespace }); console.log(JSON.stringify({ namespace: n.namespaceInfo?.name, verified: true })); return; }
      const campaignId = CallSchema.shape.campaignId.parse(args[0]), limit = Number(args[1] ?? 5), selection = args.slice(2).map(x => CallSchema.shape.candidateId.parse(x));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw Error('BRAND_ENTRY.LIMIT');
      const workflowId = `brand-entry-campaign-${campaignId}-${randomUUID()}`;
      const handle = await client.workflow.start('AmazonBrandEntryCampaignWorkflow', { workflowId, taskQueue: CONTROL_QUEUE,
        args: [{ campaignId, limit, selection }], retry: { maximumAttempts: 1 }, workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE });
      console.log(JSON.stringify({ workflowId: handle.workflowId, runId: handle.firstExecutionRunId, campaignId, limit, selection })); return;
    } finally { await connection.close(); }
  }
  if (command === 'recover-browser') {
    if (!config.cliPath) throw Error('BRAND_ENTRY.CONFIG_REQUIRED');
    const runner = new BrowserRunner(configFile, { cliPath: config.cliPath, journalRoot: config.journalRoot, runtimeRoot: config.runtimeRoot }, join(root, 'browser-script.js'));
    console.log(JSON.stringify(await runner.recover(CallSchema.parse({ campaignId: args[0], candidateId: args[1] })))); return;
  }
  if (!config.database) throw Error('BRAND_ENTRY.CONFIG_REQUIRED');
  const db = new pg.Pool({ connectionString: config.database.connectionString, ssl: config.database.tls ? { rejectUnauthorized: true } : false,
    max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  try {
    const ledger = new BrandEntryLedger(db);
    if (command === 'migrate') {
      const sql = await fs.readFile(new URL('../../../../database/v3-brand-entry/001_preparation.sql', import.meta.url), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex'), c = await db.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL lock_timeout='5s'; SELECT pg_advisory_xact_lock(73110325)");
        const identity = (await c.query('SELECT current_database() name')).rows[0];
        if (!['crawler_v3_dev', 'crawler_v3_test'].includes(identity.name)) throw Error('BRAND_ENTRY.DATABASE_IDENTITY');
        const exists = (await c.query("SELECT to_regclass('brand_entry.migration') name")).rows[0].name;
        if (exists) {
          const rows = (await c.query('SELECT name,sha256 FROM brand_entry.migration')).rows;
          if (rows.length !== 1 || rows[0].name !== '001_preparation.sql' || rows[0].sha256 !== digest) throw Error('BRAND_ENTRY.MIGRATION_CONFLICT');
        } else {
          await c.query(sql.replace(/^BEGIN;/, '').replace(/COMMIT;\s*$/, ''));
          await c.query('INSERT INTO brand_entry.migration(name,sha256) VALUES($1,$2)', ['001_preparation.sql', digest]);
        }
        await c.query('COMMIT'); console.log(JSON.stringify({ migration: '001_preparation.sql', sha256: digest, alreadyApplied: Boolean(exists) }));
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return;
    }
    if (command === 'import') {
      const data = JSON.parse(await fs.readFile(args[0]!, 'utf8')), campaignId = CallSchema.shape.campaignId.parse(args[1]);
      console.log(JSON.stringify(await ledger.import(campaignId, data.brands))); return;
    }
    if (command === 'status') {
      const campaignId = CallSchema.shape.campaignId.parse(args[0]);
      console.log(JSON.stringify({ campaignId, counts: await ledger.status(campaignId), recent: (await db.query("SELECT id,input->>'name' name,state,result->>'code' code,result->'cleanup' cleanup,finished_at FROM brand_entry.candidate WHERE campaign_id=$1 AND state<>'pending' ORDER BY claimed_at DESC LIMIT 10", [campaignId])).rows })); return;
    }
    throw Error('BRAND_ENTRY.UNKNOWN_COMMAND');
  } finally { await db.end(); }
}
main().catch(e => { console.error(e instanceof Error && /^BRAND_ENTRY\.[A-Z_]+$/.test(e.message) ? e.message : 'BRAND_ENTRY.CLI_FAILED'); process.exitCode = 1; });
