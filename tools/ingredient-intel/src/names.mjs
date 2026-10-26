// Step "names": Supply Smart ingredient names → branded ingredient links, and the ®/™ spellings of new names.
//
// Every run matches ALL names again (≈212k, about a second): when the registry gains an alias or an
// ingredient, old names are linked too. Only the difference with the last reported links is written out.
// A name is "new" when its id is not in state/seen-names.json.gz (seeded with the 2026-10-16 export, whose
// spellings were judged then); the spellings of new names go to the judgement step.
// The links are saved (saveLinks) only when the whole run has succeeded: a failed run leaves map.json as it
// was, so the next run reports its changes again instead of losing them in a failed run's folder.
import { join } from 'node:path';
import { RULES_VERSION, key, markedSpellings } from './rules.mjs';
import { loadRegistry } from './registry.mjs';
import { readJson, readJsonGz, statePath, writeJson, writeJsonl } from './lib/state.mjs';

const MAX_CONTEXTS = 5;
// Fewer names or branded ingredients than this share of the last run means a short answer, not deletions.
const MIN_SHARE = 0.9;

/** previous: the links to compare with (default state/map.json) */
export async function linkNames({ dataDir, supplySmart, names, now, log, problem, previous }) {
  const registry = await loadRegistry(dataDir);
  const matcher = registry.matcher();

  // Supply Smart decides which branded ingredients exist; a link to one it doesn't hold can't be shown.
  const held = new Set((await supplySmart.brandedIngredients()).map((b) => b.externalKey).filter(Boolean));
  const last = previous ?? (await readJson(statePath(dataDir, 'map.json'))) ?? {};
  for (const [what, count, before] of [['原料名', names.length, last.names], ['品牌原料', held.size, last.held]])
    if (!count || (before && count < before * MIN_SHARE))
      throw new Error(`Supply Smart 只返回了 ${count} 个${what}（上次 ${before ?? '—'}），像是没读全，本次不更新映射`);
  const notInSupplySmart = [...registry.externalKeys].filter((k) => !held.has(k));
  const notInRegistry = [...held].filter((k) => !registry.externalKeys.has(k));
  if (notInRegistry.length) problem(`Supply Smart 有 ${notInRegistry.length} 个品牌原料不在本地登记表里，没法匹配：${notInRegistry.slice(0, 5).join(', ')}`);

  const links = {};
  for (const n of names) {
    const keys = matcher.keys(n.name).filter((k) => held.has(k));
    if (keys.length) links[n.id] = keys;
  }

  const before = last.links ?? {};
  const byId = new Map(names.map((n) => [n.id, n]));
  const changes = [];
  for (const [id, keys] of Object.entries(links))
    for (const k of keys)
      if (!before[id]?.includes(k)) changes.push(linkChange('add', id, byId.get(id)?.name, k, now));
  for (const [id, keys] of Object.entries(before))
    for (const k of keys)
      if (!links[id]?.includes(k)) changes.push(linkChange('remove', id, byId.get(id)?.name ?? null, k, now, byId.has(id) ? 'rule' : 'name_gone'));

  // ®/™ spellings of the names not looked at before, with the names they occur in.
  const seen = new Set((await readJsonGz(statePath(dataDir, 'seen-names.json.gz')))?.ids ?? []);
  const fresh = names.filter((n) => !seen.has(n.id));
  const spellings = new Map();
  for (const n of fresh) {
    for (const spelling of new Set(markedSpellings(n.name))) {
      const k = key(spelling);
      if (!spellings.has(k)) spellings.set(k, { key: k, spelling, nameIds: [], contexts: [] });
      const s = spellings.get(k);
      s.nameIds.push(n.id);
      if (s.contexts.length < MAX_CONTEXTS) s.contexts.push(n.name.slice(0, 160));
    }
  }

  const summary = {
    names: names.length,
    linked_names: Object.keys(links).length,
    links: Object.values(links).reduce((n, v) => n + v.length, 0),
    added: changes.filter((c) => c.action === 'add').length,
    removed: changes.filter((c) => c.action === 'remove').length,
    new_names: fresh.length,
    new_marked_names: fresh.filter((n) => markedSpellings(n.name).length).length,
    new_spellings: spellings.size,
    registry_keys_not_in_supply_smart: notInSupplySmart.length,
  };
  log.info(summary, 'names linked');
  return { summary, registry, links, changes, map: { names: names.length, held: held.size, links }, fresh, spellings, seen };
}

/** The run's link changes, then the links they lead to (a crash in between repeats the changes next run). */
export async function saveLinks({ dataDir, runDir, now, changes, map }) {
  await writeJsonl(join(runDir, 'changes', 'alias_links.jsonl'), changes);
  await writeJson(statePath(dataDir, 'map.json'), { as_of: now, rules_version: RULES_VERSION, ...map });
}

const linkChange = (action, ingredientId, name, externalKey, now, reason = null) => ({
  kind: 'alias_link',
  action,
  ingredient_id: ingredientId,
  ingredient_name: name,
  external_key: externalKey,
  method: 'rule',
  rules_version: RULES_VERSION,
  ...(reason ? { reason } : {}),
  detected_at: now,
});
