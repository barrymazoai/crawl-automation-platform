// node --env-file=<supply smart env> src/run.mjs collect --data-dir <dir> --mode backfill|incremental|targeted
//      [--companies "id or name|…"] [--ingredients "id or name|…"] [--max-pages N] [--refresh-aliases]
// node --env-file=<supply smart env> src/run.mjs deliver --data-dir <dir>
//
// collect writes <dir>/studies, index.jsonl, state.json and runs/<run-id>/ (log, manifest, archived pages);
// deliver writes <dir>/deliveries/<run-id>/, the directory Supply Smart's importer reads.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pino from 'pino';
import lockfile from 'proper-lockfile';
import { collect } from './collect.mjs';
import { createCtgovClient } from './ctgov/client.mjs';
import { deliver } from './deliver.mjs';
import { loadEntities, loadManualAliases } from './entities.mjs';
import { createCompanyMatcher } from './match/companies.mjs';
import { createIngredientMatcher } from './match/ingredients.mjs';
import { createSupplySmart } from './supply-smart.mjs';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'data-dir': { type: 'string', default: process.env.CLINICAL_TRIALS_DATA_DIR },
    mode: { type: 'string', default: 'incremental' },
    companies: { type: 'string', default: '' },
    ingredients: { type: 'string', default: '' },
    'max-pages': { type: 'string' },
    'refresh-aliases': { type: 'boolean', default: false },
  },
});
const step = positionals[0];
if (!['collect', 'deliver'].includes(step)) throw new Error('first argument must be collect or deliver');
if (!args['data-dir']) throw new Error('--data-dir (or CLINICAL_TRIALS_DATA_DIR) is required');
if (step === 'collect' && !['backfill', 'incremental', 'targeted'].includes(args.mode)) throw new Error('--mode must be backfill, incremental or targeted');
// Company names contain commas ("Athletic Greens (USA), Inc."), so lists are separated by |.
const split = (v) => v.split('|').map((s) => s.trim()).filter(Boolean);
const only = { companies: split(args.companies), ingredients: split(args.ingredients) };
if (args.mode === 'targeted' && !only.companies.length && !only.ingredients.length) throw new Error('--mode targeted needs --companies or --ingredients');

const dataDir = resolve(args['data-dir']);
const now = new Date().toISOString();
const runId = `${step}-${now.replace(/[:.]/g, '-')}`;
const runDir = join(dataDir, step === 'collect' ? 'runs' : 'deliveries', runId);
await mkdir(runDir, { recursive: true });
const log = pino(
  { base: { run: runId }, timestamp: pino.stdTimeFunctions.isoTime },
  pino.multistream([{ stream: process.stdout }, { stream: pino.destination({ dest: join(runDir, 'run.log'), sync: true }) }]),
);

const release = await lockfile.lock(dataDir, { lockfilePath: join(dataDir, '.run.lock'), stale: 6 * 60 * 60 * 1000, update: 60 * 1000 });
try {
  const supplySmart = createSupplySmart({
    databaseRpcUrl: process.env.SUPPLY_SMART_DATABASE_RPC_URL,
    apiKey: process.env.SUPPLY_SMART_API_KEY,
    requestsPerMinute: Number(process.env.SUPPLY_SMART_REQUESTS_PER_MINUTE ?? 120),
  });
  const entities = await loadEntities({ supplySmart, dataDir, log, refreshAliases: args['refresh-aliases'] });
  const matchers = {
    companies: createCompanyMatcher(entities.companies, await loadManualAliases(dataDir)),
    ingredients: createIngredientMatcher(entities.brandedIngredients),
  };
  if (step === 'collect') {
    const ctgov = createCtgovClient({
      log,
      intervalMs: Number(process.env.CTGOV_INTERVAL_MS ?? 1500),
      retries: 3,
      timeoutMs: 120_000,
      userAgent: process.env.CTGOV_USER_AGENT ?? 'clinical-trials-collector/0.1 (Supply Smart; public registry data)',
    });
    const maxPages = args['max-pages'] ? Number(args['max-pages']) : Infinity;
    await collect({ dataDir, runDir, runId, mode: args.mode, ctgov, entities, matchers, log, maxPages, only, now });
  } else {
    const sourceDb = process.env.SUPPLY_SMART_SOURCE_DB ?? (supplySmart.source === 'test.supplysmart.net' ? 'cloud-test' : supplySmart.source);
    await deliver({ dataDir, runDir, runId, supplySmart, entities, matchers, log, sourceDb });
  }
} finally {
  await release();
}
