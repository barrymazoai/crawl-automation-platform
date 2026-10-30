// Product-enrichment/4 backfill driver (owner 2026-10-26): re-enriches every sent product on an older protocol, a
// few at a time, and after each batch brings the products' form, health functions and main ingredients in Supply
// Smart up to date (preview first, then write). Docs: README.md next to this file.
//
//   node run.mjs --state-dir <dir> [--concurrency 3] [--batch 100] [--stop-after 5000]
//
// Writes go through the crawler API only (enrichment.run, productSync.updateEnrichment); the database is read
// read-only (the product list and Supply Smart product IDs). Node built-ins only.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'state-dir': { type: 'string' },
    api: { type: 'string', default: 'http://127.0.0.1:4188' },
    'worker-config': {
      type: 'string',
      default: '/Users/server/apps/crawler-v3/manual-releases/deploy-r46/worker.private.json',
    },
    psql: { type: 'string', default: '/opt/homebrew/opt/postgresql@18/bin/psql' },
    concurrency: { type: 'string', default: '3' },
    batch: { type: 'string', default: '100' },
    'stop-after': { type: 'string', default: '5000' },
    // Stop (and report) when one batch's enrichment failures exceed this share, or the 5-minute load passes this.
    'max-failure-rate': { type: 'string', default: '0.1' },
    'max-load': { type: 'string', default: '28' },
  },
});
if (!args['state-dir']) throw new Error('--state-dir is required');
const dir = args['state-dir'];
mkdirSync(dir, { recursive: true });
const concurrency = Number(args.concurrency);
const batchSize = Math.min(100, Number(args.batch));
const stopAfter = Number(args['stop-after']);
const PROTOCOL = 'product-enrichment/4';
const files = {
  plan: join(dir, 'plan.json'),
  progress: join(dir, 'progress.json'),
  outcomes: join(dir, 'outcomes.jsonl'),
  failures: join(dir, 'failures.jsonl'),
  updates: join(dir, 'updates.jsonl'),
  log: join(dir, 'run.log'),
  stop: join(dir, 'STOP'),
};

const log = (message) => {
  const line = `${new Date().toISOString()} ${message}`;
  appendFileSync(files.log, `${line}\n`);
  console.log(line);
};
const appendJson = (file, value) => appendFileSync(file, `${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── read-only database ───────────────────────────────────────────────────────
const databaseUrl = JSON.parse(readFileSync(args['worker-config'], 'utf8')).database.connectionString;
function readOnly(sql) {
  const out = execFileSync(args.psql, [databaseUrl, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: `SET default_transaction_read_only = on;\nSET statement_timeout = '120s';\n${sql}`,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  return out.trim();
}
const literal = (text) => `'${String(text).replaceAll("'", "''")}'`;

// The same selection as enrichment.outdated (packages/adapters/src/postgres/enrichment-selection.ts), without a
// limit: never enriched first, then /2, then the rest. Taken once; a failed product is never picked again.
const PLAN_SQL = `
  WITH sent AS (
    SELECT DISTINCT ps.collected_operation_id AS operation_id,
           CASE ps.channel WHEN 'wholefoods' THEN 'amazon' ELSE ps.channel END AS channel
      FROM product_sync ps
     WHERE ps.collected_operation_id IS NOT NULL AND ps.status IN ('verified', 'sent')),
  targets AS MATERIALIZED (
    SELECT t.operation_id, t.channel, o."listingId" AS listing_id, o."variantId" AS variant_id
      FROM sent t JOIN collected_product p ON p.operation_id = t.operation_id
      CROSS JOIN LATERAL jsonb_to_record(p.record->'observation') AS o("listingId" text, "variantId" text)),
  latest AS (
    SELECT DISTINCT ON (s.collection_operation_id, s.channel, s.listing_id, s.variant_id)
           s.collection_operation_id, s.channel, s.listing_id, s.variant_id, e.protocol AS codec
      FROM product_enrichment_subject s JOIN product_enrichment e USING (enrichment_id)
     ORDER BY s.collection_operation_id, s.channel, s.listing_id, s.variant_id,
              s.registered_at DESC, s.subject_id DESC)
  SELECT coalesce(json_agg(json_build_object('collectionOperationId', t.operation_id, 'channel', t.channel,
           'listingId', t.listing_id, 'variantId', t.variant_id, 'codec', latest.codec)
         ORDER BY CASE WHEN latest.codec IS NULL THEN 0 WHEN latest.codec = 'product-enrichment/2' THEN 1 ELSE 2 END,
           t.channel, t.listing_id, t.variant_id NULLS FIRST, t.operation_id), '[]')
    FROM targets t
    LEFT JOIN latest ON latest.collection_operation_id = t.operation_id AND latest.channel = t.channel
     AND latest.listing_id = t.listing_id AND latest.variant_id IS NOT DISTINCT FROM t.variant_id
   WHERE latest.codec IS DISTINCT FROM ${literal(PROTOCOL)};`;

/** Supply Smart products of the ledger rows that deliver these collections (Whole Foods rows read Amazon's). */
function supplySmartProducts(requests) {
  if (!requests.length) return [];
  const ops = requests.map((request) => literal(request.collectionOperationId)).join(',');
  const out = readOnly(`
    SELECT coalesce(json_agg(DISTINCT supply_smart_product_id::text), '[]') FROM product_sync
     WHERE collected_operation_id IN (${ops}) AND supply_smart_product_id IS NOT NULL
       AND status IN ('verified', 'sent', 'failed');`);
  return JSON.parse(out).sort();
}

// ── crawler API ──────────────────────────────────────────────────────────────
/**
 * A deploy restarts the crawler API: a request it never answered (fetch failed, connection refused or reset) is sent
 * again every minute for up to 30 minutes (owner 2026-10-27). An answer, even an error (a Supply Smart refusal), and
 * the 5-minute timeout are never retried. The calls are safe to repeat: a status read, an idempotent update, and an
 * enrichment start (at worst the product is enriched once more).
 */
async function api(path, input, method = 'POST') {
  const deadline = Date.now() + 30 * 60_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await apiOnce(path, input, method);
    } catch (error) {
      const unreachable = error instanceof TypeError && error.message === 'fetch failed';
      if (!unreachable || Date.now() + 60_000 > deadline) throw error;
      log(`${path}: crawler API unreachable (${error.cause?.code ?? error.cause?.message ?? 'fetch failed'}), try ${attempt + 1} in 60 s`);
      await sleep(60_000);
    }
  }
}

async function apiOnce(path, input, method) {
  const url = new URL(`/trpc/${path}`, args.api);
  const init = { method, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(300_000) };
  if (method === 'GET') url.searchParams.set('input', JSON.stringify(input));
  else init.body = JSON.stringify(input);
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(`${path} ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 600)}`);
  }
  return body.result.data;
}

const request = (item) => ({
  collectionOperationId: item.collectionOperationId,
  channel: item.channel,
  listingId: item.listingId,
  variantId: item.variantId,
});

/** One product: start its enrichment workflow and wait for it to end (at most 30 minutes). Never retried. */
async function enrich(item, index) {
  const started = await api('enrichment.run', { limit: 1, approvedCount: 1, products: [request(item)] });
  const workflowId = started.started[0]?.workflowId;
  if (!workflowId) throw new Error(`enrichment.run started nothing for ${index}`);
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const state = await api('enrichment.workflow', { workflowId }, 'GET');
    if (state.status !== 'RUNNING') {
      const outcome = state.outcome ?? null;
      const ok = state.status === 'COMPLETED' && outcome?.status === 'registered';
      return { index, ...request(item), workflowId, status: state.status, outcome, ok };
    }
    if (Date.now() > deadline) {
      return { index, ...request(item), workflowId, status: 'TIMEOUT', outcome: null, ok: false };
    }
    await sleep(5_000);
  }
}

/** Preview the batch's Supply Smart products, then write them with the same request; any surprise stops. */
async function updateSupplySmart(batchNumber, requests) {
  const ids = supplySmartProducts(requests);
  const totals = { products: ids.length, updated: 0, skipped: 0, added: {}, removed: {} };
  for (let start = 0; start < ids.length; start += 100) {
    let productIds = ids.slice(start, start + 100);
    let preview = await api('productSync.updateEnrichment', { limit: 100, productIds, dryRun: true });
    // A product Supply Smart no longer has (owner 2026-10-27: skip it) is recorded and left out; the rest is previewed
    // again without it, so the write still has an exact preview. Any other refusal stops.
    const missing = preview.failures.filter((failure) => failure.code === 'NOT_FOUND');
    if (missing.length && missing.length === preview.failures.length) {
      for (const failure of missing) {
        appendJson(files.failures, { at: new Date().toISOString(), batch: batchNumber, stage: 'supply-smart', ...failure });
      }
      const gone = new Set(missing.map((failure) => failure.productId));
      productIds = productIds.filter((id) => !gone.has(id));
      totals.missing = (totals.missing ?? 0) + missing.length;
      if (!productIds.length) continue;
      preview = await api('productSync.updateEnrichment', { limit: 100, productIds, dryRun: true });
    }
    if (preview.failures.length) {
      appendJson(files.updates, { batch: batchNumber, stage: 'preview', preview });
      return { stop: `Supply Smart refused ${preview.failures.length} product(s) in the preview` };
    }
    const input = { limit: 100, productIds };
    const written = await api('productSync.updateEnrichment', { ...input, dryRun: false });
    const same =
      written.updated === preview.updated &&
      JSON.stringify(written.added) === JSON.stringify(preview.added) &&
      JSON.stringify(written.removed) === JSON.stringify(preview.removed);
    appendJson(files.updates, {
      batch: batchNumber,
      at: new Date().toISOString(),
      productIds: productIds.length,
      preview: summary(preview),
      written: summary(written),
      failures: written.failures,
    });
    totals.updated += written.updated;
    totals.skipped += written.skipped;
    for (const kind of ['added', 'removed']) {
      for (const [name, count] of Object.entries(written[kind])) {
        totals[kind][name] = (totals[kind][name] ?? 0) + count;
      }
    }
    if (written.failures.length) return { stop: `Supply Smart refused ${written.failures.length} product(s)`, totals };
    if (!same) return { stop: 'the write differed from its preview', totals };
  }
  return { totals };
}
const summary = (report) => ({
  checked: report.checked,
  skipped: report.skipped,
  updated: report.updated,
  added: report.added,
  removed: report.removed,
});

// ── main ─────────────────────────────────────────────────────────────────────
if (!existsSync(files.plan)) {
  log('taking the product list (read-only)…');
  const plan = JSON.parse(readOnly(PLAN_SQL));
  writeFileSync(files.plan, JSON.stringify(plan));
  writeFileSync(files.progress, JSON.stringify({ next: 0, done: 0, failed: 0, batches: 0 }));
  const byCodec = {};
  for (const item of plan) byCodec[item.codec ?? 'none'] = (byCodec[item.codec ?? 'none'] ?? 0) + 1;
  log(`plan: ${plan.length} products ${JSON.stringify(byCodec)}`);
}
const plan = JSON.parse(readFileSync(files.plan, 'utf8'));
const progress = JSON.parse(readFileSync(files.progress, 'utf8'));
const saveProgress = () => writeFileSync(files.progress, JSON.stringify(progress));
let processedThisRun = 0;
let stopReason = null;

// Owner 2026-10-30: Codex answers 429 Too Many Requests in bursts and the worker never retries it, so a product fails
// at once with TEXT.CODEX_TURN_FAILED. The first such failure stops new products; the batch ends with those in
// flight, waits 10 minutes, and goes on with one product alone; when that one is enriched the batches go on as before.
// Still failing after 6 pauses (an hour) stops the run. These failures are not counted in the batch failure rate.
const CODEX_LIMITED = 'TEXT.CODEX_TURN_FAILED';
const CODEX_PAUSE_MS = 10 * 60_000;
const CODEX_MAX_PAUSES = 6;
let codexPauses = 0;
let probing = false;
const codexLimited = (result) => result.outcome?.code === CODEX_LIMITED;

/** Waits out a Codex pause a minute at a time, so a STOP file still ends it. */
async function codexPause() {
  for (let waited = 0; waited < CODEX_PAUSE_MS; waited += 60_000) {
    if (existsSync(files.stop)) return;
    await sleep(60_000);
  }
}
log(`start at ${progress.next}/${plan.length}, concurrency ${concurrency}, batch ${batchSize}, stop after ${stopAfter}`);

/** A batch is enriched before Supply Smart is updated; an update cut short is finished first on the next start. */
async function finishUpdate() {
  const pending = progress.pendingUpdate;
  if (!pending) return null;
  let update;
  try {
    update = await updateSupplySmart(pending.batch, pending.requests);
  } catch (error) {
    return `Supply Smart update: ${error.message}`;
  }
  log(`batch ${pending.batch}: Supply Smart ${JSON.stringify(update.totals ?? {})}`);
  if (update.stop) return `batch ${pending.batch}: ${update.stop}`;
  delete progress.pendingUpdate;
  saveProgress();
  return null;
}
stopReason = await finishUpdate();

while (!stopReason && progress.next < plan.length) {
  if (existsSync(files.stop)) {
    stopReason = 'STOP file';
    break;
  }
  const load = loadavg()[1];
  if (load > Number(args['max-load'])) {
    stopReason = `Server 一 5-minute load ${load.toFixed(1)} > ${args['max-load']}`;
    break;
  }
  const first = progress.next;
  const items = plan.slice(first, first + (probing ? 1 : batchSize));
  const results = [];
  let cursor = 0;
  let limited = false;
  const worker = async () => {
    while (cursor < items.length && !limited) {
      const offset = cursor++;
      const result = await enrich(items[offset], first + offset);
      appendJson(files.outcomes, { at: new Date().toISOString(), ...result });
      if (!result.ok) appendJson(files.failures, { at: new Date().toISOString(), ...result });
      if (codexLimited(result)) limited = true;
      results.push(result);
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } catch (error) {
    stopReason = `crawler API: ${error.message}`;
    break;
  }
  const failed = results.filter((result) => !result.ok).length;
  const counted = results.filter((result) => !result.ok && !codexLimited(result)).length;
  progress.batches += 1;
  // Every product started has ended: with a Codex pause the batch is the products started before it.
  progress.next = first + cursor;
  progress.done += results.length - failed;
  progress.failed += failed;
  processedThisRun += items.length;
  progress.pendingUpdate = { batch: progress.batches, requests: results.filter((result) => result.ok).map(request) };
  saveProgress();
  log(`batch ${progress.batches}: products ${first}–${progress.next - 1}, enriched ${results.length - failed}, failed ${failed}`);
  stopReason = await finishUpdate();
  if (stopReason) break;
  if (!probing && counted / results.length > Number(args['max-failure-rate'])) {
    stopReason = `batch ${progress.batches}: ${counted}/${results.length} enrichments failed (not counting Codex 429)`;
    break;
  }
  if (limited) {
    codexPauses += 1;
    if (codexPauses > CODEX_MAX_PAUSES) {
      stopReason = `Codex still rate limited (${CODEX_LIMITED}) after ${CODEX_MAX_PAUSES} pauses of 10 minutes`;
      break;
    }
    log(`Codex rate limited (${CODEX_LIMITED}): pause ${codexPauses}/${CODEX_MAX_PAUSES} for 10 minutes, then one product alone`);
    await codexPause();
    probing = true;
    continue;
  }
  if (probing) log('Codex answers again: batches go on');
  probing = false;
  codexPauses = 0;
  if (processedThisRun >= stopAfter) {
    stopReason = `checkpoint: ${processedThisRun} products this run`;
    break;
  }
}
log(
  `stopped: ${stopReason ?? 'plan finished'}; at ${progress.next}/${plan.length}, enriched ${progress.done}, failed ${progress.failed}`,
);
