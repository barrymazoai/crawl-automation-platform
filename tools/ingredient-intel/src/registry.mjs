// The branded ingredients the matcher knows (state/registry.json). A row the 10-16 USPTO check showed to be
// another ingredient keeps its aliases but reports the ingredient it duplicates (duplicate_of), as the
// supplier-intel export did; Supply Smart only holds the surviving external keys.
import { createMatcher } from './rules.mjs';
import { readJson, statePath } from './lib/state.mjs';

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
      const m = createMatcher(registry.ingredients);
      return { ...m, keys: (name) => [...new Set([...m.hits(name)].map((id) => target.get(id)))].sort() };
    },
  };
}
