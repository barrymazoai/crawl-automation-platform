// node src/import-supplier-intel.mjs --data-dir <dir> --supplier-intel <folder> [--force]
//
// Builds <dir>/state from the 2026-10-13…16 supplier-intel run (MacBook ~/Documents/supplier-intel, not in
// git), so the scheduled job starts where that run stopped and reuses its judgements:
//   registry.json       the 1,282 rows the 10-16 matcher used (ingredients.csv, ingredients_new_dedup.csv,
//                       ingredients_ss.csv + aliases_extra.csv; marked-only aliases from
//                       out/ingredients_all/candidates.csv; duplicate_of from out/uspto_new/per_ingredient_ss.csv)
//   verdicts.jsonl      the model's 4,731 spelling judgements (out/candidates_*/classified.jsonl), rejected ones too
//   map.json            the links Supply Smart imported (export/supply_smart/out/label/ss_ingredient_brand_map.csv)
//   seen-names.json.gz  the ingredient ids of the 10-16 Supply Smart export (raw/ids/ss_ingredient.tsv): their
//                       spellings were already sent for judgement then
// Only these small files are read; raw responses and PDFs stay on the MacBook. An existing state is kept
// unless --force, because later runs add judgements to it.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'csv-parse/sync';
import { key } from './rules.mjs';
import { statePath, writeJson, writeJsonGz, writeJsonl } from './lib/state.mjs';

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: process.env.INGREDIENT_INTEL_DATA_DIR },
    'supplier-intel': { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});
if (!args['data-dir'] || !args['supplier-intel']) throw new Error('--data-dir and --supplier-intel are required');
const dataDir = resolve(args['data-dir']);
const W = resolve(args['supplier-intel']);
const exists = (file) => stat(file).then(() => true, () => false);
if (!args.force && (await exists(statePath(dataDir, 'registry.json'))))
  throw new Error(`${statePath(dataDir, 'registry.json')} exists; pass --force to replace the whole state`);

const csv = async (file) => parse(await readFile(join(W, file), 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true });
const list = (text, sep) => (text ?? '').split(sep).map((s) => s.trim()).filter(Boolean);

// ── Registry ────────────────────────────────────────────────────────────────

const extra = new Map();
for (const r of await csv('input/aliases_extra.csv')) extra.set(r.id, [...(extra.get(r.id) ?? []), r.alias]);
const markedOnly = new Map((await csv('out/ingredients_all/candidates.csv')).map((r) => [r.canonical, list(r.marked_only_aliases, '; ')]));
const duplicateOf = new Map((await csv('out/uspto_new/per_ingredient_ss.csv')).filter((r) => r.duplicate_of).map((r) => [r.id, r.duplicate_of]));
const registry = [];
for (const [file, source] of [
  ['input/ingredients.csv', 'supplier-intel ING001–ING100'],
  ['input/ingredients_new_dedup.csv', 'supplier-intel labels 2026-10-15'],
  ['input/ingredients_ss.csv', 'supplier-intel Supply Smart names 2026-10-16'],
]) {
  for (const r of await csv(file)) {
    registry.push({
      id: r.id,
      ingredient: r.ingredient,
      generic_name: r.generic_name || null,
      supplier_guess: r.supplier_guess || null,
      aliases: [...list(r.aliases, ';'), ...(extra.get(r.id) ?? [])],
      marked_only_aliases: markedOnly.get(r.ingredient) ?? [],
      duplicate_of: duplicateOf.get(r.id) ?? null,
      source,
    });
  }
}

// ── Judgements ──────────────────────────────────────────────────────────────

// Several spellings share a key (case, punctuation); the one on most products speaks for the key.
const verdicts = new Map();
const classified = (await readdir(join(W, 'out'))).filter((d) => d.startsWith('candidates_')).sort();
for (const dir of classified) {
  for (const line of (await readFile(join(W, 'out', dir, 'classified.jsonl'), 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const k = key(r.spelling);
    const v = {
      key: k,
      spelling: r.spelling,
      class: r.class,
      canonical: r.canonical ?? null,
      existing_id: r.existing_id ?? null,
      supplier: r.supplier ?? null,
      generic_name: r.generic_name ?? null,
      confidence: r.confidence ?? null,
      note: r.note ?? null,
      products: r.products ?? null,
      decided_by: 'supplier-intel gpt-6.1-sol medium',
      decided_at: '2026-10-15',
      batch: dir,
    };
    const prior = verdicts.get(k);
    if (!prior) verdicts.set(k, v);
    else {
      const [keep, other] = (v.products ?? 0) > (prior.products ?? 0) ? [v, prior] : [prior, v];
      if (other.class !== keep.class) keep.other_classes = [...new Set([...(keep.other_classes ?? []), other.class])];
      verdicts.set(k, keep);
    }
  }
}

// ── Links Supply Smart holds, and the names already looked at ───────────────

const map = {};
for (const r of await csv('export/supply_smart/out/label/ss_ingredient_brand_map.csv'))
  map[r.ingredient_id] = [...new Set([...(map[r.ingredient_id] ?? []), r.branded_ingredient_external_key])].sort();
const seen = (await readFile(join(W, 'raw/ids/ss_ingredient.tsv'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t', 1)[0]);

const importedAt = new Date().toISOString();
await writeJson(statePath(dataDir, 'registry.json'), { imported_from: W, imported_at: importedAt, ingredients: registry });
await writeJsonl(statePath(dataDir, 'verdicts.jsonl'), [...verdicts.values()].sort((a, b) => a.key.localeCompare(b.key)));
await writeJson(statePath(dataDir, 'map.json'), { as_of: '2026-10-16 Supply Smart import', links: map });
await writeJsonGz(statePath(dataDir, 'seen-names.json.gz'), { as_of: '2026-10-16 Supply Smart export', ids: seen });
console.log(
  JSON.stringify({
    registry: registry.length,
    duplicates: registry.filter((r) => r.duplicate_of).length,
    verdicts: verdicts.size,
    verdict_batches: classified.length,
    map_names: Object.keys(map).length,
    map_links: Object.values(map).reduce((n, v) => n + v.length, 0),
    seen_names: seen.length,
  }),
);
