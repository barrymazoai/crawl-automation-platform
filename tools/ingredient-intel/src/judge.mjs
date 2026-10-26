// Step "judge": decide what each new ®/™ spelling is, cheapest source first (owner 2026-10-26: reuse what
// was judged before, so the model only sees spellings nobody has looked at):
//   1. the spelling is an alias of a registered branded ingredient → nothing to judge;
//   2. state/verdicts.jsonl already holds a judgement for it → reused as is. An "unsure" one is asked
//      again only when new names put it on at least 2 products;
//   3. otherwise the model (Luna) judges it, 50 spellings per call, with the same task the 10-15 run gave
//      the model (supplier-intel tasks/candidates.md). Each answered batch is saved at once.
// A supplier ingredient the model ties to a registered one with high confidence becomes a new alias of it;
// an unregistered supplier ingredient is a candidate (shown nowhere until P3 confirms it).
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { codexJson } from '../../regulatory/src/lib/codex.mjs';
import { key } from './rules.mjs';
import { activeAliases, usableModelAlias } from './registry.mjs';
import { readJsonl, statePath, writeJson, writeJsonGz, writeJsonl } from './lib/state.mjs';

export const PROMPT_VERSION = 'spelling-class-v1';
const BATCH = 50;
const CLASSES = ['supplier_ingredient', 'product_brand_own', 'certification_or_packaging', 'company_or_brand_name', 'fragment_or_noise', 'unsure'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['spelling', 'class', 'canonical', 'existing_id', 'supplier', 'generic_name', 'confidence', 'note'],
        properties: {
          spelling: { type: 'string', description: 'The input spelling, unchanged.' },
          class: { type: 'string', enum: CLASSES },
          canonical: { type: ['string', 'null'] },
          existing_id: { type: ['string', 'null'] },
          supplier: { type: ['string', 'null'] },
          generic_name: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: ['string', 'null'] },
        },
      },
    },
  },
};

function buildPrompt(items, registry) {
  const known = registry.ingredients
    .filter((r) => !r.duplicate_of)
    .map((r) => `${r.id} | ${r.ingredient}${r.supplier_guess ? ` | ${r.supplier_guess}` : ''}`)
    .join('\n');
  return `You classify spellings that appear next to ® or ™ in supplement ingredient names (label lines) in our product database.

Goal: find supplier branded ingredients. A supplier branded ingredient is a trademarked raw material that an ingredient
company sells to many supplement brands (e.g. KSM-66 by Ixoreal, BioPerine by Sabinsa, Albion/TRAACS minerals by Balchem,
probiotic strains such as BB-12, Kaneka Ubiquinol). Supplier excipients and functional carriers (e.g. Nu-FLOW by RIBUS)
count too; say "excipient" in note. NOT wanted: the product brand's own names (its proprietary blend, product line or
slogan, e.g. "Energy Blend™" sold only by that brand), finished-product names, certification/quality marks and packaging or
capsule technologies (Non-GMO Project, NSF, DRcaps, Vcaps), company or retailer names, and OCR fragments.

For every input spelling return one result with the spelling copied unchanged:
- class: "supplier_ingredient" | "product_brand_own" | "certification_or_packaging" | "company_or_brand_name" |
  "fragment_or_noise" | "unsure".
- canonical: for supplier_ingredient, the ingredient's trademark name as the supplier writes it (e.g. "KSM-66"). Different
  spellings of one ingredient (case, OCR errors, extra words such as "ksm-66 ashwagandha") get the same canonical. When it
  is one of the known branded ingredients below, use that name and set existing_id to its id; otherwise existing_id null.
- supplier: the company that owns or sells the ingredient, only if you know it; never guess (null).
- generic_name: what it is (e.g. "ashwagandha root extract"), or null.
- confidence: "high" | "medium" | "low". note: one short sentence when the call is not obvious, else null.
Each judgement comes from the contexts and what you know about the name. "products" counts our products whose ingredient
list carries it (0 = seen only in a label panel row); "brands" counts their brands.

Known branded ingredients (id | name | supplier):
${known}

Spellings (JSON lines):
${items.map((i) => JSON.stringify({ spelling: i.spelling, products: i.products, brands: i.brands, top_brands: i.topBrands, contexts: i.contexts })).join('\n')}`;
}

export async function judgeSpellings({ dataDir, runDir, runId, supplySmart, registry, links, fresh, spellings, seen, model, effort, maxBatches, now, log, problem }) {
  const verdictsFile = statePath(dataDir, 'verdicts.jsonl');
  const verdicts = new Map((await readJsonl(verdictsFile)).map((v) => [v.key, v]));
  // Only aliases the matcher uses: a model alias too short to match (registry.mjs) goes to review again.
  const aliasKeys = new Set(registry.ingredients.flatMap((r) => [r.ingredient, ...activeAliases(r)]).map(key));

  const outcome = new Map(); // spelling key → 'alias' | 'reused' | 'asked' | 'unanswered'
  const toAsk = [];
  const unsure = [];
  for (const s of spellings.values()) {
    if (aliasKeys.has(s.key)) outcome.set(s.key, 'alias');
    else if (!verdicts.has(s.key)) toAsk.push(s);
    else if (verdicts.get(s.key).class === 'unsure') unsure.push(s);
    else outcome.set(s.key, 'reused');
  }

  // Products and brands, for what the model reads, the "unsure on ≥ 2 products" rule and the candidate list.
  const reusedSupplier = [...spellings.values()].filter((s) => outcome.get(s.key) === 'reused' && verdicts.get(s.key).class === 'supplier_ingredient');
  const lookup = [...toAsk, ...unsure, ...reusedSupplier];
  const ids = [...new Set(lookup.flatMap((s) => s.nameIds))];
  const products = ids.length ? await supplySmart.productsUsing(ids) : [];
  const productsOf = new Map();
  for (const p of products)
    for (const id of p.ingredientIds) {
      if (!productsOf.has(id)) productsOf.set(id, []);
      productsOf.get(id).push(p);
    }
  for (const s of lookup) {
    const ps = new Map(s.nameIds.flatMap((id) => productsOf.get(id) ?? []).map((p) => [p.id, p]));
    const brands = new Map();
    for (const p of ps.values()) if (p.company) brands.set(p.company, (brands.get(p.company) ?? 0) + 1);
    s.products = ps.size;
    s.brands = brands.size;
    s.topBrands = [...brands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([b]) => b);
  }
  for (const s of unsure) {
    if (s.products >= 2) toAsk.push(s);
    else outcome.set(s.key, 'reused');
  }
  toAsk.sort((a, b) => b.products - a.products || a.key.localeCompare(b.key));

  // The model, one batch at a time; every answer is saved before the next call.
  const asked = { batches: 0, spellings: 0, answered: 0, tokens: 0, failed_batches: 0, left_for_next_run: 0 };
  const registryIds = new Set(registry.ingredients.map((r) => r.id));
  let failedInRow = 0;
  for (let i = 0; i < toAsk.length; i += BATCH) {
    const items = toAsk.slice(i, i + BATCH);
    if (asked.batches >= maxBatches || failedInRow >= 2) {
      for (const s of items) outcome.set(s.key, 'unanswered');
      asked.left_for_next_run += items.length;
      continue;
    }
    asked.batches += 1;
    asked.spellings += items.length;
    try {
      const prompt = buildPrompt(items, registry);
      const res = await codexJson({ prompt, schema: SCHEMA, model, effort, timeoutMs: 15 * 60_000, retries: 2, log: log.child({ batch: asked.batches }) });
      failedInRow = 0;
      asked.tokens += res.tokens ?? 0;
      const answers = new Map(res.answer.results.map((r) => [key(r.spelling), r]));
      for (const s of items) {
        const a = answers.get(s.key);
        if (!a) {
          outcome.set(s.key, 'unanswered');
          continue;
        }
        const existing = a.existing_id && registryIds.has(a.existing_id) ? a.existing_id : null;
        verdicts.set(s.key, {
          key: s.key,
          spelling: s.spelling,
          class: a.class,
          canonical: a.canonical,
          existing_id: existing,
          supplier: a.supplier,
          generic_name: a.generic_name,
          confidence: a.confidence,
          note: a.existing_id && !existing ? `${a.note ?? ''} (unknown existing_id ${a.existing_id} dropped)`.trim() : a.note,
          products: s.products,
          brands: s.brands,
          contexts: s.contexts,
          decided_by: `${res.model} ${res.effort}`,
          prompt_version: PROMPT_VERSION,
          prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
          decided_at: now,
          run_id: runId,
        });
        outcome.set(s.key, 'asked');
        asked.answered += 1;
      }
      await writeJsonl(verdictsFile, [...verdicts.values()].sort((a, b) => a.key.localeCompare(b.key)));
    } catch (error) {
      failedInRow += 1;
      asked.failed_batches += 1;
      for (const s of items) outcome.set(s.key, 'unanswered');
      problem(`Luna 分类第 ${asked.batches} 批失败：${error.shortMessage ?? error.message}`);
    }
  }
  if (asked.left_for_next_run) log.warn({ left: asked.left_for_next_run }, 'spellings left for the next run');

  // What the judgements mean for the registry and the candidate list.
  const candidates = new Map();
  const review = [];
  const aliasesAdded = [];
  let covered = 0;
  // The 10-15 batches could only name the ingredients that existed when they ran, so an old judgement often
  // has no existing_id although its canonical name is registered today: resolve it by name.
  const byName = new Map();
  for (const r of registry.ingredients) for (const n of [r.ingredient, ...activeAliases(r)]) if (!byName.has(key(n))) byName.set(key(n), r);
  for (const s of spellings.values()) {
    const state = outcome.get(s.key);
    const v = verdicts.get(s.key);
    if (!v || state === 'alias' || state === 'unanswered' || v.class !== 'supplier_ingredient') continue;
    const row = registry.ingredients.find((r) => r.id === v.existing_id) ?? (v.canonical ? byName.get(key(v.canonical)) : null);
    if (row) {
      // Names the matcher already links to it (through another spelling in the same name) need nothing.
      const target = row.duplicate_of ?? row.id;
      if (s.nameIds.every((id) => links[id]?.includes(target))) {
        covered += 1;
        continue;
      }
      // A judgement of this prompt counts whether it was made now or by a run that stopped before saving the
      // registry; the 10-15 judgements were made for review, not to add aliases.
      const ours = v.prompt_version === PROMPT_VERSION;
      if (ours && v.confidence === 'high' && usableModelAlias(s.spelling)) {
        row.aliases.push(s.spelling);
        row.aliases_added = [...(row.aliases_added ?? []), { alias: s.spelling, run_id: runId, decided_by: v.decided_by }];
        aliasesAdded.push({ external_key: target, ingredient: row.ingredient, alias: s.spelling, names: s.nameIds.length });
      } else {
        const reason = !ours ? 'old_verdict_not_alias' : v.confidence !== 'high' ? 'existing_not_high_confidence' : 'alias_too_short';
        review.push({ reason, spelling: s.spelling, external_key: target, ingredient: row.ingredient, verdict: v, names: s.nameIds.length, contexts: s.contexts });
      }
    } else {
      const c = candidates.get(v.canonical ?? s.spelling) ?? { kind: 'ingredient_candidate', canonical: v.canonical ?? s.spelling, spellings: [], supplier: v.supplier, generic_name: v.generic_name, confidence: v.confidence, products: 0, names: 0, contexts: [], detected_at: now };
      c.spellings.push(s.spelling);
      c.products += s.products ?? 0;
      c.names += s.nameIds.length;
      c.contexts.push(...s.contexts.slice(0, 5 - c.contexts.length));
      candidates.set(c.canonical, c);
    }
  }
  if (aliasesAdded.length)
    await writeJson(statePath(dataDir, 'registry.json'), { imported_from: registry.imported_from, imported_at: registry.imported_at, ingredients: registry.ingredients });
  await writeJsonl(join(runDir, 'changes', 'ingredient_candidates.jsonl'), [...candidates.values()].sort((a, b) => b.products - a.products));
  await writeJsonl(join(runDir, 'review.jsonl'), review);
  await writeJsonl(join(runDir, 'aliases_added.jsonl'), aliasesAdded);

  // A new name is done when none of its spellings is still waiting for a judgement.
  const waiting = new Set([...outcome.entries()].filter(([, o]) => o === 'unanswered').map(([k]) => k));
  const waitingNames = new Set([...spellings.values()].filter((s) => waiting.has(s.key)).flatMap((s) => s.nameIds));
  for (const n of fresh) if (!waitingNames.has(n.id)) seen.add(n.id);
  await writeJsonGz(statePath(dataDir, 'seen-names.json.gz'), { as_of: now, ids: [...seen] });

  const count = (o) => [...outcome.values()].filter((x) => x === o).length;
  const classes = {};
  for (const [k, o] of outcome) if (o === 'asked') classes[verdicts.get(k).class] = (classes[verdicts.get(k).class] ?? 0) + 1;
  const summary = {
    spellings: spellings.size,
    alias: count('alias'),
    reused: count('reused'),
    asked: count('asked'),
    unanswered: count('unanswered'),
    asked_classes: classes,
    model: { model, effort, ...asked },
    covered_by_other_spelling: covered,
    aliases_added: aliasesAdded.length,
    candidates: candidates.size,
    review: review.length,
    names_waiting: waitingNames.size,
  };
  log.info(summary, 'spellings judged');
  return { summary, aliasesAdded };
}
