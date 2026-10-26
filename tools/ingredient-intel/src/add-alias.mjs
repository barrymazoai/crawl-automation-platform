// node src/add-alias.mjs --data-dir <dir> --id <registry id> --alias <spelling> --reason <why>
//
// A reviewed alias: someone checked the names it links. It is kept in aliases_manual with the reason, and the
// length rule for the model's aliases (registry.mjs) never turns it off. The next sync links the names and
// reports them in changes/alias_links.jsonl. Takes the sync lock, so it never runs during a sync.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import lockfile from 'proper-lockfile';
import { activeAliases } from './registry.mjs';
import { key } from './rules.mjs';
import { readJson, statePath, writeJson } from './lib/state.mjs';

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: process.env.INGREDIENT_INTEL_DATA_DIR },
    id: { type: 'string' },
    alias: { type: 'string' },
    reason: { type: 'string' },
  },
});
if (!args['data-dir'] || !args.id || !args.alias?.trim() || !args.reason?.trim()) throw new Error('--data-dir, --id, --alias and --reason are required');
const dataDir = resolve(args['data-dir']);
const alias = args.alias.trim().toLowerCase();

const release = await lockfile.lock(dataDir, { lockfilePath: join(dataDir, '.sync.lock'), stale: 6 * 60 * 60 * 1000, update: 60 * 1000 });
try {
  const file = statePath(dataDir, 'registry.json');
  const registry = await readJson(file);
  const row = registry.ingredients.find((r) => r.id === args.id);
  if (!row) throw new Error(`${args.id} is not in ${file}`);
  if (key(alias).length < 2) throw new Error(`"${alias}" has fewer than 2 letters and digits`);
  const other = registry.ingredients.find((r) => r !== row && activeAliases(r).some((a) => key(a) === key(alias)));
  if (other) throw new Error(`"${alias}" is already an alias of ${other.id} ${other.ingredient}`);
  if (row.aliases_manual?.some((a) => a.alias === alias)) throw new Error(`"${alias}" is already a reviewed alias of ${row.id}`);
  if (!row.aliases.includes(alias)) row.aliases.push(alias);
  row.aliases_manual = [...(row.aliases_manual ?? []), { alias, reason: args.reason.trim(), added_at: new Date().toISOString() }];
  await writeJson(file, registry);
  console.log(JSON.stringify({ id: row.id, ingredient: row.ingredient, alias, aliases_manual: row.aliases_manual.length }));
} finally {
  await release();
}
