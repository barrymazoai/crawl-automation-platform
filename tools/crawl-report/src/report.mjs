// node src/report.mjs --state-dir <dir> [--dry-run] [--out <file>] [--supply-smart-env <file> | --local-db-env <file>]
//   [--crawler-api http://127.0.0.1:4188/trpc | --rounds-file <rounds.list answer>]
//   [--regulatory-data <dir>] [--ingredient-intel-data <dir>] [--days 120] [--partial-share 0.05]
//
// KAN-229: one report per finished round to Supply Smart's crawlReport.submit, for its admin Data updates
// page. Sources: the crawler API's rounds.list (Amazon, Costco, GNC, Swanson, Whole Foods, DTC), the
// Regulatory sync records and the ingredient-intel runs (branded ingredients, clinical trials). A plain
// script, no model. A report is sent again only when its content changed (state: <state-dir>/sent.json);
// Supply Smart replaces a report with the same (source, runId).
//   --dry-run   print what would be sent; nothing is sent and no state is written
//   --out       also write the reports as JSON (works with --dry-run)
//   --local-db-env  local test: write into a local Supply Smart product DB (its packages/product-db/.env)
//                   instead of calling the API; keep a separate --state-dir for it
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import pino from 'pino';
import lockfile from 'proper-lockfile';
import stringify from 'safe-stable-stringify';
import { crawlerReports, crawlerRounds } from './sources/crawler.mjs';
import { ingredientIntelReports } from './sources/ingredient-intel.mjs';
import { regulatoryReports } from './sources/regulatory.mjs';
import { localDbFromEnvFile } from './local-db.mjs';
import { supplySmartFromEnvFile } from './supply-smart.mjs';
import { problems as reportProblems } from './validate.mjs';

const { values: args } = parseArgs({
  options: {
    'state-dir': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    out: { type: 'string' },
    'supply-smart-env': { type: 'string' },
    'local-db-env': { type: 'string' },
    'crawler-api': { type: 'string', default: 'http://127.0.0.1:4188/trpc' },
    'rounds-file': { type: 'string' },
    'regulatory-data': { type: 'string' },
    'ingredient-intel-data': { type: 'string' },
    days: { type: 'string', default: '120' },
    'partial-share': { type: 'string', default: '0.05' },
  },
});
const log = pino({ base: null, timestamp: pino.stdTimeFunctions.isoTime });
const DRY = args['dry-run'];
const STATE = args['state-dir'];
if (!STATE) throw new Error('--state-dir is required');
if (!DRY && !args['supply-smart-env'] === !args['local-db-env']) {
  throw new Error('give one of --supply-smart-env and --local-db-env, or --dry-run');
}

const here = dirname(fileURLToPath(import.meta.url));
const version = await promisify(execFile)('git', ['rev-parse', '--short', 'HEAD'], { cwd: here }).then(
  ({ stdout }) => stdout.trim(),
  () => 'unknown',
);
const crawler = (name) => ({ name: `browser-scaperskill/${name}`, version });
const since = new Date(Date.now() - Number(args.days) * 86_400_000).toISOString();

/** Each source is read on its own: one that cannot be read is logged, the others are still reported. */
async function collect() {
  const parts = [
    [
      'crawler',
      async () =>
        crawlerReports(await crawlerRounds({ api: args['crawler-api'], roundsFile: args['rounds-file'], since, log }), {
          crawler: crawler('crawler-v3'),
          partialShare: Number(args['partial-share']),
        }),
    ],
    ...(args['regulatory-data']
      ? [['regulatory', () => regulatoryReports({ dataDir: args['regulatory-data'], crawler: crawler('tools/regulatory'), log })]]
      : []),
    ...(args['ingredient-intel-data']
      ? [['ingredient-intel', () => ingredientIntelReports({ dataDir: args['ingredient-intel-data'], crawler: crawler('tools/ingredient-intel') })]]
      : []),
  ];
  const reports = [];
  const failures = [];
  for (const [name, read] of parts) {
    try {
      reports.push(...(await read()));
    } catch (error) {
      failures.push(name);
      log.error({ source: name, err: error.message }, 'source not read');
    }
  }
  return { reports: reports.filter((r) => r.finishedAt >= since), failures };
}

/** The crawler's version is left out, so a code update alone does not resend every report. */
const fingerprint = ({ crawler: _version, ...report }) => createHash('sha256').update(stringify(report)).digest('hex');

async function readState() {
  return readFile(join(STATE, 'sent.json'), 'utf8').then(JSON.parse, () => ({}));
}

async function writeState(state) {
  const file = join(STATE, 'sent.json');
  await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 1)}\n`);
  await rename(`${file}.tmp`, file);
}

async function target() {
  return args['local-db-env']
    ? localDbFromEnvFile(args['local-db-env'])
    : supplySmartFromEnvFile(args['supply-smart-env'], { log });
}

/** One report at a time; each success is saved at once, a failure is left for the next run. */
async function sendAll(reports, state) {
  const supplySmart = await target();
  log.info({ target: supplySmart.target ?? supplySmart.host, reports: reports.length }, 'sending');
  let sent = 0;
  let failed = 0;
  try {
    for (const r of reports) {
      try {
        const answer = await supplySmart.submit(r);
        state[`${r.source}|${r.runId}`] = {
          hash: fingerprint(r),
          sentAt: new Date().toISOString(),
          reportId: answer.reportId ?? null,
          counted: answer.counted ?? null,
          warnings: answer.warnings ?? [],
        };
        await writeState(state);
        sent += 1;
        if (answer.warnings?.length) log.warn({ source: r.source, runId: r.runId, warnings: answer.warnings }, 'Supply Smart warnings');
      } catch (error) {
        failed += 1;
        log.error({ source: r.source, runId: r.runId, err: error.message }, 'report not sent');
      }
    }
  } finally {
    await supplySmart.close?.();
  }
  return { sent, failed };
}

function line(report, mark) {
  const c = report.counts;
  return [
    mark.padEnd(9),
    report.source.padEnd(18),
    report.runId.padEnd(34),
    report.status.padEnd(9),
    report.finishedAt.slice(0, 16),
    `targets ${c.targets} fetched ${c.fetched} failed ${c.failed} pushed ${c.pushed}`,
    report.ingestRunIds ? `ingestRuns ${report.ingestRunIds.length}` : '',
  ].join(' ');
}

await mkdir(STATE, { recursive: true });
const release = await lockfile.lock(STATE, { stale: 30 * 60_000 });
try {
  const { reports, failures } = await collect();
  const state = await readState();
  const invalid = reports.filter((r) => reportProblems(r).length);
  for (const r of invalid) log.error({ source: r.source, runId: r.runId, problems: reportProblems(r) }, 'report not sent: invalid');
  const valid = reports.filter((r) => !reportProblems(r).length);
  const changed = valid.filter((r) => state[`${r.source}|${r.runId}`]?.hash !== fingerprint(r));
  if (args.out) await writeFile(args.out, `${JSON.stringify(valid, null, 1)}\n`);
  for (const r of valid) console.log(line(r, changed.includes(r) ? (DRY ? 'would' : 'send') : 'same'));
  const { sent, failed } = DRY || !changed.length ? { sent: 0, failed: 0 } : await sendAll(changed, state);
  log.info(
    { reports: valid.length, changed: changed.length, sent, failed, invalid: invalid.length, unreadSources: failures, dryRun: DRY },
    'crawl report done',
  );
  if (failed || invalid.length || failures.length) process.exitCode = 1;
} finally {
  await release();
}
