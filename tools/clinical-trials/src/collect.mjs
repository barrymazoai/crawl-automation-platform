// Collect: page through ClinicalTrials.gov, keep the studies that matter to Supply Smart, store them.
//
//   backfill     every registered study (≈610 pages of 1000); studies kept earlier but no longer in the
//                registry get removed_at. First run, then monthly reconcile.
//   incremental  studies whose LastUpdatePostDate is on or after the previous run's data date minus
//                3 days (≈650 a day), plus sponsor / intervention searches for brands and branded
//                ingredients that are new in Supply Smart since the previous run.
//   targeted     only the searches for the --companies / --ingredients given (names or ids).
//
// A study is kept when an intervention is a dietary supplement, a sponsor or collaborator matches a
// Supply Smart company, or a branded ingredient is named in it. The reasons go into the index.
import { format, parseISO, subDays } from 'date-fns';
import { join } from 'node:path';
import { contentHash, loadIndex, readState, writeIndex, writeJson, writeState, writeStudy } from './store.mjs';
import { isDietarySupplement, lastUpdate, nctId } from './ctgov/study.mjs';
import { nameVariants, searchName } from './match/names.mjs';

export async function collect({ dataDir, runDir, runId, mode, ctgov, entities, matchers, log, maxPages, only, now }) {
  const state = await readState(dataDir);
  const index = await loadIndex(dataDir);
  const version = await ctgov.version();
  log.info({ mode, version }, 'collect started');

  const queries = [];
  if (mode === 'backfill') queries.push({ label: 'registry', params: {} });
  if (mode === 'incremental') {
    if (!state.watermark) throw new Error('no previous run: run --mode backfill first');
    const since = format(subDays(parseISO(state.watermark), 3), 'yyyy-MM-dd');
    queries.push({ label: `updated-since-${since}`, params: { 'filter.advanced': `AREA[LastUpdatePostDate]RANGE[${since},MAX]` } });
    const knownCompanies = new Set(state.known_company_ids ?? []);
    const knownIngredients = new Set(state.known_ingredient_ids ?? []);
    queries.push(...entityQueries(
      entities.companies.filter((c) => !knownCompanies.has(c.id)),
      entities.brandedIngredients.filter((bi) => !knownIngredients.has(bi.id)),
    ));
  }
  if (mode === 'targeted') {
    const pick = (list, wanted) => list.filter((e) => wanted.some((w) => w === e.id || w.toLowerCase() === e.name.toLowerCase()));
    queries.push(...entityQueries(pick(entities.companies, only.companies), pick(entities.brandedIngredients, only.ingredients)));
  }

  const counts = { seen: 0, kept_new: 0, kept_updated: 0, kept_unchanged: 0, not_kept: 0 };
  const seen = new Set();
  const report = [];
  let complete = true;
  for (const query of queries) {
    const q = { label: query.label, params: query.params, total: null, pages: 0, returned: 0, studies: 0, reached_last_page: false, archives: [] };
    report.push(q);
    for await (const page of ctgov.studies({ params: query.params, label: query.label, archiveDir: join(runDir, 'pages'), maxPages })) {
      q.total ??= page.totalCount;
      q.pages += 1;
      q.returned += page.studies.length;
      q.reached_last_page = page.last;
      q.archives.push({ file: page.archive.file, sha256: page.archive.sha256, bytes: page.archive.bytes });
      for (const study of page.studies) {
        const nct = nctId(study);
        if (!nct || seen.has(nct)) continue;
        seen.add(nct);
        q.studies += 1;
        counts.seen += 1;
        const reasons = keepReasons(study, matchers);
        const prev = index.get(nct);
        if (reasons.length === 0 && !prev) {
          counts.not_kept += 1;
          continue;
        }
        const hash = contentHash(study);
        const entry = {
          nct_id: nct,
          last_update: lastUpdate(study),
          content_hash: hash,
          kept_because: reasons.length ? reasons : (prev?.kept_because ?? []),
          first_seen_at: prev?.first_seen_at ?? now,
          last_seen_at: now,
          changed_at: prev?.content_hash === hash ? prev.changed_at : now,
          page: { file: page.archive.file, sha256: page.archive.sha256 },
        };
        if (!prev || prev.content_hash !== hash) await writeStudy(dataDir, nct, study);
        counts[!prev ? 'kept_new' : prev.content_hash !== hash ? 'kept_updated' : 'kept_unchanged'] += 1;
        index.set(nct, entry);
      }
      if (q.pages % 50 === 0) {
        await writeIndex(dataDir, index);
        log.info({ query: q.label, pages: q.pages, total: q.total, ...counts }, 'progress');
      }
    }
    // The registry grows during a long scan, so completeness is reaching the last page, not the first count.
    if (!q.reached_last_page) complete = false;
  }

  let removed = 0;
  if (mode === 'backfill' && complete) {
    for (const entry of index.values()) {
      if (!seen.has(entry.nct_id) && !entry.removed_at) {
        entry.removed_at = now;
        removed += 1;
      } else if (seen.has(entry.nct_id) && entry.removed_at) delete entry.removed_at;
    }
  }
  await writeIndex(dataDir, index);

  // A targeted run reads only a few searches: it never moves the watermark or the known entities.
  if (complete) {
    await writeState(dataDir, {
      ...state,
      last_collect: { run_id: runId, mode, at: now, data_timestamp: version.dataTimestamp },
      ...(mode === 'targeted'
        ? {}
        : {
            watermark: version.dataTimestamp.slice(0, 10),
            known_company_ids: entities.companies.map((c) => c.id),
            known_ingredient_ids: entities.brandedIngredients.map((bi) => bi.id),
          }),
      ...(mode === 'backfill' ? { last_backfill: { run_id: runId, at: now } } : {}),
    });
  }
  const manifest = {
    run_id: runId,
    step: 'collect',
    mode,
    started_at: now,
    finished_at: new Date().toISOString(),
    complete,
    api_version: version.apiVersion,
    data_timestamp: version.dataTimestamp,
    entities: { source: entities.source, companies: entities.companies.length, branded_ingredients: entities.brandedIngredients.length },
    counts: { ...counts, removed, stored: [...index.values()].filter((e) => !e.removed_at).length },
    queries: report,
    requests: { total: ctgov.requests.length, failed: ctgov.requests.filter((r) => r.outcome === 'failed').length, retried: ctgov.requests.filter((r) => r.attempts > 1).length },
  };
  await writeJson(join(runDir, 'manifest.json'), manifest);
  log.info({ complete, ...manifest.counts }, 'collect finished');
  return manifest;
}

function keepReasons(study, matchers) {
  const reasons = [];
  if (isDietarySupplement(study)) reasons.push('dietary_supplement');
  for (const link of matchers.companies.matchStudy(study)) reasons.push(`sponsor:${link.company.id}`);
  for (const link of matchers.ingredients.matchStudy(study).links) reasons.push(`ingredient:${link.bi.id}`);
  return [...new Set(reasons)];
}

/** Sponsor searches for companies, intervention searches for ingredient names and aliases. */
function entityQueries(companies, ingredients) {
  const out = [];
  // The search is wide on purpose ("Thorne" for "Thorne Research" finds "Thorne HealthTech");
  // the company matcher decides what is kept.
  for (const c of companies) {
    out.push({ label: `sponsor-${c.id}`, params: { 'query.spons': `"${searchName(c.name)}"` } });
  }
  for (const bi of ingredients) {
    const terms = new Set([bi.name, ...(bi.aliases ?? [])].flatMap(nameVariants).map((t) => t.replace(/\([^)]*\)/g, ' ').replace(/"/g, '').trim()).filter((t) => t.length >= 3));
    for (const [i, term] of [...terms].entries()) out.push({ label: `ingredient-${bi.id}-${i}`, params: { 'query.intr': `"${term}"` } });
  }
  return out;
}
