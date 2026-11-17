// node src/run.mjs --env <file> --data-dir <dir> [--months 36 | --from YYYY-MM --to YYYY-MM]
//                  [--direction import|export] [--only <code,code>] [--push] [--codes <codes.json>]
//                  [--webhook-file <file>]
//
// Pulls U.S. monthly trade by code × partner country from the Census International Trade API for the
// codes in codes.json, and with --push sends it to Supply Smart's customsTrade.ingest (KAN-282):
// every batch as a dry run first, the real batches only when all dry runs pass. Without --push it
// fetches, archives and reports the dry-run counts only, writing nothing in Supply Smart.
//
// The default window is the last 36 published months: every run re-reads them, so Census revisions of
// past months (the previous years every June) reach Supply Smart without a separate job.
//
// Env file (private, never logged): CENSUS_API_KEY, SUPPLY_SMART_DATABASE_RPC_URL, SUPPLY_SMART_API_KEY.
//
// --webhook-file (the 「Supply Smart 服务通知」 bot, as the regulatory sync): a green card after a push,
// a red card naming the stage when a run fails (the error with every env value redacted). check-sync.mjs
// covers a run that never starts.
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { feishuNotifier } from '../../notify/feishu.mjs';
import { failureCard, redact, successCard } from './alert.mjs';
import { createCensus, createSupplySmart } from './clients.mjs';
import { addCounts, batchId, monthRange, monthsBack, toBatches, toSlices } from './slices.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_CODE = '2936270000'; // vitamin C: imported every month

const { values: args } = parseArgs({
  options: {
    env: { type: 'string' },
    'data-dir': { type: 'string' },
    months: { type: 'string', default: '36' },
    from: { type: 'string' },
    to: { type: 'string' },
    direction: { type: 'string' },
    only: { type: 'string' },
    codes: { type: 'string', default: join(HERE, '..', 'codes.json') },
    push: { type: 'boolean', default: false },
    'webhook-file': { type: 'string' },
  },
});
if (!args.env || !args['data-dir']) throw new Error('--env and --data-dir are required');
if (args.direction && !['import', 'export'].includes(args.direction)) throw new Error('--direction is import or export');

const log = {
  info: (o, msg) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg, ...o })),
  warn: (o, msg) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg, ...o })),
  error: (o, msg) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg, ...o })),
};

const dataDir = resolve(args['data-dir']);
const notifier = await feishuNotifier(args['webhook-file'], { log });
let env = {};
let stage = 'start';
let lock = null;
const lockPath = join(dataDir, '.run.lock');

try {
  env = parseEnv(await readFile(args.env, 'utf8'));
  await mkdir(dataDir, { recursive: true });
  // One run at a time
  lock = await open(lockPath, 'wx').catch((e) => {
    throw new Error(e.code === 'EEXIST' ? `${lockPath} exists: another run is going (remove it if that run is dead)` : e.message);
  });
  await lock.write(`${process.pid} ${new Date().toISOString()}\n`);

  stage = 'fetch';
  const census = createCensus({ apiKey: env.CENSUS_API_KEY, log });
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runId = `customs-${fetchedAt}`;
  const runDir = join(dataDir, 'runs', runId.replace(/:/g, ''));
  await mkdir(join(runDir, 'census'), { recursive: true });

  const latest = args.to ?? (await census.latestMonth({ probeCode: PROBE_CODE }));
  const from = args.from ?? monthsBack(latest, Number(args.months) - 1);
  const months = monthRange(from, latest);
  log.info({ runId, from, to: latest, months: months.length }, 'window');

  const list = JSON.parse(await readFile(args.codes, 'utf8'));
  const only = args.only ? new Set(args.only.split(',').map((c) => c.trim())) : null;
  const targets = ['import', 'export']
    .filter((d) => !args.direction || d === args.direction)
    .flatMap((d) => list[d].map((c) => ({ direction: d, ...c })))
    .filter((t) => !only || only.has(t.code));
  if (!targets.length) throw new Error('no codes selected');

  // 1. Fetch everything first: nothing is pushed unless every code was read
  const slices = [];
  const perCode = [];
  for (const t of targets) {
    const rows = await census.rows(t.direction, t.code, from, latest);
    await writeFile(join(runDir, 'census', `${t.direction}-${t.code}.json`), JSON.stringify(rows));
    const s = toSlices(t.direction, t.code, rows, months);
    slices.push(...s);
    const n = s.reduce((a, x) => a + x.rows.length, 0);
    perCode.push({ direction: t.direction, code: t.code, ingredient: t.ingredient, rows: n, emptyMonths: s.filter((x) => !x.rows.length).length });
    log.info({ direction: t.direction, code: t.code, censusRows: rows.length, rows: n }, 'fetched');
  }
  await writeFile(join(runDir, 'slices.jsonl'), slices.map((s) => JSON.stringify(s)).join('\n') + '\n');

  // 2. Dry runs of every batch, then (with --push) the real ones
  stage = 'dry';
  const supplySmart = createSupplySmart({ databaseRpcUrl: env.SUPPLY_SMART_DATABASE_RPC_URL, apiKey: env.SUPPLY_SMART_API_KEY, log });
  const batches = toBatches(slices);
  const run = { runId, fetchedAt };
  const send = async (dryRun) => {
    const counts = {};
    for (const [i, part] of batches.entries()) {
      const res = await supplySmart.ingest({ run, batchId: batchId(i), dryRun, slices: part });
      addCounts(counts, res.counts);
    }
    return counts;
  };
  const dry = await send(true);
  log.info({ supplySmart: supplySmart.host, batches: batches.length, dry }, 'dry runs passed');
  stage = 'push';
  const real = args.push ? await send(false) : null;
  if (real) log.info({ counts: real }, 'pushed');

  const report = {
    runId,
    fetchedAt,
    supplySmart: supplySmart.host,
    window: { from, to: latest, months: months.length },
    codes: targets.length,
    slices: slices.length,
    rows: slices.reduce((a, s) => a + s.rows.length, 0),
    batches: batches.length,
    pushed: Boolean(real),
    dryRun: dry,
    counts: real,
    perCode,
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(dataDir, 'last-run.json'), JSON.stringify({ ...report, perCode: undefined }, null, 2));
  console.log(JSON.stringify({ ...report, perCode: undefined }));
  if (real) {
    const sent = await notifier.send(successCard(report));
    log.info({ notification: sent }, 'success card');
  }
} catch (error) {
  const host = (() => {
    try {
      return new URL(env.SUPPLY_SMART_DATABASE_RPC_URL).host;
    } catch {
      return null;
    }
  })();
  const message = redact(error?.message ?? error, Object.values(env));
  log.error({ stage, err: message }, 'run failed');
  const sent = await notifier.send(failureCard({ host, stage, error: message, dataDir }));
  log.info({ notification: sent }, 'failure card');
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
