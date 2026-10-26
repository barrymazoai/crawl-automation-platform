// The branded ingredients the matcher knows (state/registry.json). A row the 10-16 USPTO check showed to be
// another ingredient keeps its aliases but reports the ingredient it duplicates (duplicate_of), as the
// supplier-intel export did; Supply Smart only holds the surviving external keys.
import { createMatcher, key } from './rules.mjs';
import { readJson, statePath } from './lib/state.mjs';

// An alias the model proposed counts only with at least 5 letters and digits, or 4 when one is a digit (strain
// codes such as Ls-33, LI-23): in the first run (2026-10-26) "mag" and "ght" linked "Vor-Mag™ Water" and
// "GHT Proprietary Blend" to Nu-MAG and VegaDELIGHT.
export const usableModelAlias = (alias) => key(alias).length >= (/\d/.test(alias) ? 4 : 5);

/** The aliases the matcher uses: the reviewed ones, and the model's that are long enough. */
export function activeAliases(row) {
  const added = new Set((row.aliases_added ?? []).map((a) => a.alias));
  return row.aliases.filter((a) => !added.has(a) || usableModelAlias(a));
}

export async function loadRegistry(dataDir) {
  const file = statePath(dataDir, 'registry.json');
  const registry = await readJson(file);
  if (!registry) throw new Error(`${file} is missing: run src/import-supplier-intel.mjs first`);
  const target = new Map(registry.ingredients.map((r) => [r.id, r.duplicate_of ?? r.id]));
  return {
    ...registry,
    externalKeys: new Set(target.values()),
    /** hits(name) → the external keys Supply Smart knows, sorted */
    matcher() {
      const m = createMatcher(registry.ingredients.map((r) => ({ ...r, aliases: activeAliases(r) })));
      return { ...m, keys: (name) => [...new Set([...m.hits(name)].map((id) => target.get(id)))].sort() };
    },
  };
}
