// The Supply Smart entities trials are matched against, saved under <data-dir>/entities/.
// Companies and the branded-ingredient list are read fresh every run (two calls); aliases need one
// call per ingredient, so they are kept in aliases-cache.json and read only for ingredients not seen
// before (or all of them with refreshAliases). Products are read per linked brand, at delivery.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from './store.mjs';

export async function loadEntities({ supplySmart, dataDir, log, refreshAliases = false }) {
  const dir = join(dataDir, 'entities');
  const companies = await supplySmart.companies();
  const list = await supplySmart.brandedIngredients();
  const cacheFile = join(dir, 'aliases-cache.json');
  const cache = refreshAliases ? {} : await readJson(cacheFile, {});
  let read = 0;
  for (const bi of list) {
    if (cache[bi.id]) continue;
    cache[bi.id] = await supplySmart.brandedIngredientAliases(bi.id);
    read += 1;
    if (read % 100 === 0) {
      log.info({ read }, 'branded ingredient aliases read');
      await writeJson(cacheFile, cache);
    }
  }
  await writeJson(cacheFile, cache);
  const brandedIngredients = list.map((bi) => ({ ...bi, aliases: cache[bi.id] ?? [] }));
  await writeJson(join(dir, 'companies.json'), companies);
  await writeJson(join(dir, 'branded-ingredients.json'), brandedIngredients);
  log.info({ companies: companies.length, brandedIngredients: brandedIngredients.length, aliasesRead: read, source: supplySmart.source }, 'entities loaded');
  return { companies, brandedIngredients, source: supplySmart.source };
}

/** Manual sponsor names: [{ sponsor, company_id, company_name?, note }]; company_id null blocks a wrong match. */
export async function loadManualAliases(dataDir) {
  return readJson(join(dataDir, 'aliases.json'), []);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
