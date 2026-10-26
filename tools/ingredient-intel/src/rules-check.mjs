// node src/rules-check.mjs --data-dir <dir> --names <id\tname file> --expect <map csv> [--out <diff.jsonl>]
//
// Replays the matcher on a saved list of Supply Smart ingredient names and compares the links with a map
// file (ingredient_id, ingredient_name, branded_ingredient_external_key, …). Run it before changing a rule
// or the registry: the 2026-10-16 files (supplier-intel raw/ids/ss_ingredient.tsv and
// export/supply_smart/out/label/ss_ingredient_brand_map.csv) are the reference the port has to reproduce.
// Reads only; prints the counts and writes every differing link to --out.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'csv-parse/sync';
import { loadRegistry } from './registry.mjs';
import { writeJsonl } from './lib/state.mjs';

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: process.env.INGREDIENT_INTEL_DATA_DIR },
    names: { type: 'string' },
    expect: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!args['data-dir'] || !args.names || !args.expect) throw new Error('--data-dir, --names and --expect are required');

const started = Date.now();
const matcher = (await loadRegistry(resolve(args['data-dir']))).matcher();
const names = new Map(
  (await readFile(args.names, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return [line.slice(0, tab), line.slice(tab + 1)];
    }),
);
const pair = (id, k) => `${id}|${k}`;
const got = new Set();
for (const [id, name] of names) for (const k of matcher.keys(name)) got.add(pair(id, k));
const expected = new Set(
  parse(await readFile(args.expect, 'utf8'), { columns: true, skip_empty_lines: true }).map((r) =>
    pair(r.ingredient_id, r.branded_ingredient_external_key),
  ),
);

const diff = [];
for (const p of got) if (!expected.has(p)) diff.push({ side: 'only_new', p });
for (const p of expected) if (!got.has(p)) diff.push({ side: 'only_expected', p });
const rows = diff.map(({ side, p }) => {
  const [id, k] = p.split('|');
  return { side, ingredient_id: id, external_key: k, name: names.get(id) ?? null };
});
if (args.out) await writeJsonl(resolve(args.out), rows);
console.log(
  JSON.stringify({
    names: names.size,
    patterns: matcher.patterns,
    links_new: got.size,
    links_expected: expected.size,
    same: got.size - rows.filter((r) => r.side === 'only_new').length,
    only_new: rows.filter((r) => r.side === 'only_new').length,
    only_expected: rows.filter((r) => r.side === 'only_expected').length,
    seconds: Math.round((Date.now() - started) / 1000),
  }),
);
for (const r of rows.slice(0, 20)) console.log(JSON.stringify(r));
