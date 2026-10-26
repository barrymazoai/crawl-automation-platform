// Step "push" (P4, owner 2026-10-26): Supply Smart is brought to what the crawler found, through its ingest
// procedures (SUPPLYSMAR-463; supply-smart-mono docs/packages/database-api/domains/branded-ingredient-ingest.md
// and clinical-trial-ingest.md). The cut is made once; every batch goes as a dry run first, and only when all
// of them pass with the expected counts is the same cut sent for real. A re-sent batch is counted once, so the
// client retries a timeout or 5xx with the same batch.
import { join } from 'node:path';
import { loadRegistry } from './registry.mjs';
import { readJson, readJsonl, statePath } from './lib/state.mjs';

const LINK_BATCH = 500;
const TRIAL_BATCH = 100;
// Taking back more than this share of Supply Smart's links (and more than 20) is a rule or data fault, not news.
const MAX_REMOVE_SHARE = 0.02;

const batchId = (i) => String(i + 1).padStart(4, '0');
const chunk = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

/** Adds the numbers of b into a, nested objects included. */
function addCounts(a, b) {
  for (const [k, v] of Object.entries(b ?? {})) {
    if (typeof v === 'number') a[k] = (a[k] ?? 0) + v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) addCounts((a[k] ??= {}), v);
  }
  return a;
}

async function send(batches, call, dryRun) {
  const counts = {};
  const unknown = [];
  for (const [i, body] of batches.entries()) {
    const res = await call({ ...body, batchId: batchId(i), dryRun });
    addCounts(counts, res.aliasLink ? { aliasLink: res.aliasLink } : res.counts);
    unknown.push(...(res.unknownIngredientIds ?? []), ...Object.values(res.unknownIds ?? {}).flat());
  }
  return { counts, unknown: [...new Set(unknown)] };
}

/** Links: syncState ↔ state/map.json; adds what is missing, takes back what the rules no longer make. */
export async function pushLinks({ dataDir, runId, now, supplySmart, names, log, dryOnly = false }) {
  const map = await readJson(statePath(dataDir, 'map.json'));
  const ours = (await loadRegistry(dataDir)).externalKeys;
  const before = await supplySmart.syncState();
  const active = new Map();
  for (const bi of before.items) for (const l of bi.links) active.set(`${l.ingredientId}|${bi.externalKey}`, l.method);
  if (active.size !== before.totals.activeLinks)
    throw new Error(`读回的映射 ${active.size} 条，和 Supply Smart 报的总数 ${before.totals.activeLinks} 对不上，没有推送`);

  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const desired = new Set(Object.entries(map.links).flatMap(([id, keys]) => keys.map((k) => `${id}|${k}`)));
  const record = (action, pair) => {
    const [id, k] = pair.split('|');
    return {
      kind: 'alias_link',
      action,
      external_key: k,
      ingredient_id: id,
      ingredient_name: nameOf.get(id) ?? null,
      method: 'rule',
      rules_version: map.rules_version,
      reason: action === 'remove' ? (nameOf.has(id) ? 'rule' : 'name_gone') : null,
      detected_at: now,
    };
  };
  const adds = [...desired].filter((p) => !active.has(p)).map((p) => record('add', p));
  // Only links of branded ingredients the crawler matches, and never one a person made.
  const removes = [...active]
    .filter(([p, method]) => !desired.has(p) && method !== 'manual' && ours.has(p.split('|')[1]))
    .map(([p]) => record('remove', p));
  const summary = { before: active.size, adds: adds.length, removes: removes.length };
  const limit = Math.max(20, Math.floor(active.size * MAX_REMOVE_SHARE));
  if (removes.length > limit) throw new Error(`这次要撤销 ${removes.length} 条映射，超过上限 ${limit}（现有的 2%），没有推送，等人看`);
  if (!adds.length && !removes.length) return { ...summary, batches: 0, after: active.size };

  const batches = chunk([...adds, ...removes], LINK_BATCH).map((records) => ({ run: { runId }, records }));
  const dry = await send(batches, supplySmart.ingestLinks, true);
  const d = dry.counts.aliasLink;
  // An add the database already has, or a remove it doesn't, means syncState and the push disagree.
  if ((d.added ?? 0) + (d.restored ?? 0) + (d.skippedUnknownIngredient ?? 0) !== adds.length || (d.removed ?? 0) !== removes.length)
    throw new Error(`映射 dry run 的结果和计划对不上（计划新增 ${adds.length}、撤销 ${removes.length}；dry run ${JSON.stringify(d)}），没有推送`);
  if (dryOnly) return { ...summary, batches: batches.length, dry_run: d, unknown_ingredient_ids: dry.unknown, after: active.size };
  const real = await send(batches, supplySmart.ingestLinks, false);
  const r = real.counts.aliasLink;
  const after = await supplySmart.syncState();
  const expected = active.size + (r.added ?? 0) + (r.restored ?? 0) - (r.removed ?? 0);
  log.info({ ...summary, real: r, after: after.totals }, 'links pushed');
  return {
    ...summary,
    batches: batches.length,
    pushed: r,
    unknown_ingredient_ids: real.unknown,
    after: after.totals.activeLinks,
    after_matches: after.totals.activeLinks === expected,
  };
}

/** Trials: one delivery of tools/clinical-trials, 100 trials per batch with every link of those trials. */
export async function pushTrials({ deliveryDir, supplySmart, log, dryOnly = false }) {
  const manifest = await readJson(join(deliveryDir, 'manifest.json'));
  const trials = await readJsonl(join(deliveryDir, 'trials.jsonl'));
  const byTrial = async (file) => {
    const out = new Map();
    for (const row of await readJsonl(join(deliveryDir, file))) {
      if (!out.has(row.nct_id)) out.set(row.nct_id, []);
      out.get(row.nct_id).push(row);
    }
    return out;
  };
  const links = { companyLinks: await byTrial('trial_company_links.jsonl'), productLinks: await byTrial('trial_product_links.jsonl'), ingredientLinks: await byTrial('trial_ingredient_links.jsonl') };
  const listed = new Set(trials.map((t) => t.nct_id));
  for (const [kind, m] of Object.entries(links))
    for (const nct of m.keys()) if (!listed.has(nct)) throw new Error(`交付 ${manifest.run_id} 里 ${kind} 有不在 trials.jsonl 的试验 ${nct}，没有推送`);

  const run = { runId: manifest.run_id, fetchedAt: manifest.fetched_at, ...(manifest.source_db ? { sourceDb: manifest.source_db } : {}) };
  const batches = chunk(trials, TRIAL_BATCH).map((part) => ({
    run,
    trials: part,
    ...Object.fromEntries(Object.entries(links).map(([kind, m]) => [kind, part.flatMap((t) => m.get(t.nct_id) ?? [])])),
  }));
  const dry = await send(batches, supplySmart.ingestTrials, true);
  if (dryOnly) return { delivery: run.runId, trials: trials.length, batches: batches.length, dry_run: dry.counts, unknown_ids: dry.unknown };
  const real = await send(batches, supplySmart.ingestTrials, false);
  log.info({ run: run.runId, trials: trials.length, counts: real.counts }, 'trials pushed');
  return { delivery: run.runId, trials: trials.length, batches: batches.length, counts: real.counts, unknown_ids: real.unknown };
}
