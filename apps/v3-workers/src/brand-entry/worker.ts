import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { createR2Objects, RetainedPublication, sha256 } from '@crawl-automation/v3-artifacts';
import { TextLocalStore } from '@crawl-automation/v3-text';
import { artifactBuildId } from '@crawl-automation/v3-worker-runtime';
import { readGncPrivateJson } from '../gnc-config.js';
import { AmazonLiveConfigSchema } from '../amazon-live-config.js';
import { entryConfig, temporalOptions } from './config.js';
import { BrandEntryLedger } from './ledger.js';
import { BrandEntrySeeds } from './seed.js';
import { BrowserRunner } from './browser-runner.js';
import { CallSchema, OutcomeSchema, CONTROL_QUEUE, BROWSER_QUEUE, safeCode, workflowId, type Call } from './contracts.js';
import { verifiedProofs } from './proofs.js';

async function main() {
  const configFile = process.argv[2]; if (!configFile) throw Error('BRAND_ENTRY.CONFIG_REQUIRED');
  const config = await entryConfig(configFile), root = dirname(fileURLToPath(import.meta.url));
  const buildId = await artifactBuildId((await fs.readdir(root)).filter(n => n.endsWith('.js') || n.endsWith('.cjs')).sort().map(n => join(root, n)));
  if (buildId !== config.expectedBuildId) throw Error('BRAND_ENTRY.BUILD_MISMATCH');
  await fs.mkdir(config.runtimeRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(config.runtimeRoot, `${config.role}.lock.json`), lock = await fs.open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), buildId, configFile })); await lock.close();
  let connection: NativeConnection | undefined;
  let db: pg.Pool | undefined, r2: ReturnType<typeof createR2Objects> | undefined, worker: Worker | undefined;
  let active: string | null = null;
  const health = async (status: string) => fs.writeFile(join(config.runtimeRoot, `${config.role}.status.json`), JSON.stringify({ at: new Date().toISOString(), status, pid: process.pid, buildId, active }), { mode: 0o600 });
  const handlers: Record<string, (raw: any) => Promise<any>> = {};
  const owner = (x: Call) => { const e = Context.current().info.workflowExecution;
    if (!e || e.workflowId !== workflowId(x)) throw Error('BRAND_ENTRY.OWNER'); return { workflowId: e.workflowId, runId: e.runId }; };
  try {
    const t = await temporalOptions(config.temporalConfigFile);
    Runtime.install({ shutdownSignals: [] });
    connection = await NativeConnection.connect({ address: t.address, tls: t.tls });
    if (config.role === 'control') {
      if (!config.database || !config.sourceConfigFile) throw Error('BRAND_ENTRY.CONFIG_REQUIRED');
      db = new pg.Pool({ connectionString: config.database.connectionString, ssl: config.database.tls ? { rejectUnauthorized: true } : false,
        max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
      db.on('error', () => console.error('BRAND_ENTRY.DB_POOL_ERROR'));
      const source = AmazonLiveConfigSchema.parse(await readGncPrivateJson(config.sourceConfigFile));
      r2 = createR2Objects(source.r2, source.r2Credentials);
      const ledger = new BrandEntryLedger(db), publication = new RetainedPublication(await TextLocalStore.open(config.journalRoot), r2.store), seeds = new BrandEntrySeeds(db, ledger, publication, source);
      await db.query('SELECT id,state FROM brand_entry.candidate LIMIT 0');
      handlers.claim = async raw => { const x = CallSchema.parse(raw), e = owner(x), row = await ledger.claim(x, e.workflowId, e.runId); return { terminal: row.result }; };
      handlers.prepareSeed = raw => { const x = CallSchema.parse(raw); return seeds.prepare(x, owner(x), Context.current().cancellationSignal); };
      handlers.releaseSeed = raw => { const x = CallSchema.parse(raw); return seeds.release(x, owner(x)); };
      handlers.readResult = async raw => { const x = CallSchema.parse(raw); owner(x); return (await ledger.get(x)).result; };
      handlers.nextCandidates = raw => ledger.pending(raw.campaignId, raw.limit, raw.selection);
      handlers.campaignStatus = raw => ledger.status(raw.campaignId);
      handlers.finish = async raw => {
        const out = OutcomeSchema.parse(raw); owner({ campaignId: out.campaignId, candidateId: out.candidateId });
        // Verify every retained object again before publishing a Brand mapping.
        if (out.state === 'verified') for (const ref of verifiedProofs(out)) {
          const bytes = await r2!.store.read(ref.key, ref.byteSize, Context.current().cancellationSignal);
          if (!bytes || bytes.length !== ref.byteSize || sha256(bytes) !== ref.sha256) throw Error('BRAND_ENTRY.EVIDENCE_UNVERIFIED');
        }
        try { return await ledger.finish(out); }
        catch (e) {
          const code = safeCode(e);
          if (out.state !== 'verified' || !['BRAND_ENTRY.BRAND_NAME_CONFLICT', 'BRAND_ENTRY.BRAND_IDENTITY_AMBIGUOUS', 'BRAND_ENTRY.BRAND_MISSING', 'BRAND_ENTRY.SOURCE_CONFLICT'].includes(code)) throw e;
          // The publication transaction rolled back. Recording its failure is a
          // terminal cleanup action, not another publication attempt.
          return ledger.finish({ ...out, state: 'review', code, verifiedAt: null });
        }
      };
    } else {
      if (!config.cliPath || !config.taskSpaceId) throw Error('BRAND_ENTRY.CONFIG_REQUIRED');
      const runner = new BrowserRunner(configFile, { cliPath: config.cliPath, journalRoot: config.journalRoot, runtimeRoot: config.runtimeRoot }, join(root, 'browser-script.js'));
      handlers.discoverEntry = raw => { owner(CallSchema.parse({ campaignId: raw.campaignId, candidateId: raw.candidateId })); return runner.discover(raw, Context.current().cancellationSignal); };
      handlers.recoverEntry = raw => { const x = CallSchema.parse(raw); owner(x); return runner.recover(x); };
    }
    const activities = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async (raw: unknown) => {
      const ctx = Context.current(); if (ctx.info.attempt !== 1) throw ApplicationFailure.nonRetryable('Business retry disabled', 'BRAND_ENTRY.RETRY_DENIED');
      active = ctx.info.workflowExecution.workflowId; await health('running');
      const timer = setInterval(() => ctx.heartbeat({ phase: name }), 2000);
      try { return await fn(raw); }
      catch (error) { throw ApplicationFailure.nonRetryable('Inspect retained Brand preparation evidence', safeCode(error)); }
      finally { clearInterval(timer); active = null; await health('ready'); }
    }]));
    worker = await Worker.create({ connection, namespace: t.namespace, taskQueue: config.role === 'control' ? CONTROL_QUEUE : BROWSER_QUEUE,
      activities, ...(config.role === 'control' ? { workflowBundle: { codePath: join(root, 'workflows.cjs') } } : {}),
      maxConcurrentActivityTaskExecutions: 1, maxConcurrentWorkflowTaskExecutions: 4, shutdownGraceTime: '10 seconds', shutdownForceTime: '45 seconds' });
    const stop = () => worker?.shutdown(); process.once('SIGTERM', stop); process.once('SIGINT', stop);
    await health('ready'); console.log(JSON.stringify({ event: 'BRAND_ENTRY_READY', role: config.role, pid: process.pid, buildId }));
    try { await worker.run(); } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
  } finally { await health('stopped'); r2?.close(); await db?.end(); await connection?.close(); await fs.rm(lockPath, { force: true }); }
}
main().catch(() => { console.error('BRAND_ENTRY.STARTUP_OR_EXECUTION_FAILED'); process.exitCode = 1; });
