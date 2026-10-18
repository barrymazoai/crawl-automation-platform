// Deliver: match every stored study against the current Supply Smart entities and write one import
// run for `pnpm -F @supply-smart/product-db import:clinical-trials -- --run=<dir>` (KAN-217):
//
//   manifest.json  trials.jsonl  trial_company_links.jsonl  trial_product_links.jsonl
//   trial_ingredient_links.jsonl   (KAN-214 draft; no importer yet)
//   review/        unmatched industry sponsors, ambiguous sponsor names, rejected weak ingredient terms
//
// The importer treats a run as authoritative for the trials it lists and deletes their link pairs that
// are missing, so trials delivered last time are listed again even when nothing links to them any more:
// that is how a wrong link that the matcher stopped making disappears from Supply Smart.
import { join } from 'node:path';
import { loadIndex, readState, readStudy, writeJson, writeJsonl, writeState } from './store.mjs';
import { matchProducts } from './match/products.mjs';
import { parties } from './ctgov/study.mjs';
import { trialRecord } from './deliver/trial-record.mjs';
import { CompanyLinkSchema, IngredientLinkSchema, ManifestSchema, ProductLinkSchema, TrialRecordSchema, checked } from './deliver/contract.mjs';
import { isDietarySupplement } from './ctgov/study.mjs';

export const MATCHER_VERSION = 'ctgov-match-1';

export async function deliver({ dataDir, runDir, runId, supplySmart, entities, matchers, log, sourceDb }) {
  const state = await readState(dataDir);
  if (!state.last_collect) throw new Error('nothing collected yet: run collect first');
  const index = await loadIndex(dataDir);
  const live = [...index.values()].filter((e) => !e.removed_at);

  // Pass 1: brand and ingredient links of every stored study.
  const found = new Map();
  const unmatchedSponsors = new Map();
  const ambiguous = [];
  const rejectedTerms = [];
  for (const [i, entry] of live.entries()) {
    const study = await readStudy(dataDir, entry.nct_id);
    const companies = matchers.companies.matchStudy(study);
    const ingredients = matchers.ingredients.matchStudy(study);
    for (const r of ingredients.rejected) rejectedTerms.push({ ...r, nct_id: entry.nct_id });
    for (const link of companies.filter((l) => l.ambiguous)) ambiguous.push({ nct_id: entry.nct_id, matched_name: link.matched_name, company_id: link.company.id, company_name: link.company.name, candidates: link.ambiguous });
    if (companies.length || ingredients.links.length) found.set(entry.nct_id, { companies, ingredients: ingredients.links });
    // Leads: industry sponsors of supplement trials that Supply Smart doesn't have.
    if (isDietarySupplement(study)) {
      const lead = parties(study).find((p) => p.role === 'lead_sponsor');
      if (lead?.class === 'INDUSTRY' && !companies.some((l) => l.role === 'lead_sponsor')) {
        const u = unmatchedSponsors.get(lead.name) ?? { sponsor: lead.name, trials: 0, nct_ids: [], latest_start: null };
        u.trials += 1;
        u.nct_ids.push(entry.nct_id);
        const start = study.protocolSection?.statusModule?.startDateStruct?.date ?? null;
        if (start && (!u.latest_start || start > u.latest_start)) u.latest_start = start;
        unmatchedSponsors.set(lead.name, u);
      }
    }
    if ((i + 1) % 5000 === 0) log.info({ studies: i + 1, of: live.length, linked: found.size }, 'matching');
  }

  // Pass 2: products, only inside brands linked high or medium.
  const brandIds = new Set();
  for (const f of found.values()) for (const l of f.companies) if (l.confidence !== 'low') brandIds.add(l.company.id);
  const products = await supplySmart.products([...brandIds]);
  const productsByCompany = new Map();
  for (const p of products) {
    if (!productsByCompany.has(p.company_id)) productsByCompany.set(p.company_id, []);
    productsByCompany.get(p.company_id).push(p);
  }
  log.info({ brands: brandIds.size, products: products.length }, 'products loaded for linked brands');

  const companyRows = [];
  const productRows = [];
  const ingredientRows = [];
  for (const [nct, f] of found) {
    for (const l of f.companies) {
      companyRows.push(checked(CompanyLinkSchema, { nct_id: nct, company_id: l.company.id, role: l.role, matched_name: l.matched_name, match_basis: l.basis, confidence: l.confidence }, 'company link'));
    }
    if (f.companies.some((l) => l.confidence !== 'low' && productsByCompany.has(l.company.id))) {
      const study = await readStudy(dataDir, nct);
      for (const l of matchProducts(study, f.companies, productsByCompany)) {
        productRows.push(checked(ProductLinkSchema, { nct_id: nct, product_id: l.product.id, intervention_name: l.intervention_name, match_basis: l.basis, confidence: l.confidence }, 'product link'));
      }
    }
    for (const l of f.ingredients) {
      ingredientRows.push(checked(IngredientLinkSchema, {
        nct_id: nct,
        branded_ingredient_id: l.bi.id,
        external_key: l.bi.externalKey ?? null,
        match_basis: l.match_basis,
        matched_term: l.matched_term,
        matched_field: l.matched_field,
        evidence_quote: l.evidence_quote,
        role: l.role,
        sponsor_is_supplier: l.sponsor_is_supplier,
        confidence: l.confidence,
        review_note: l.review_note,
      }, 'ingredient link'));
    }
  }

  const linked = new Set(found.keys());
  const listed = [...new Set([...linked, ...(state.delivered_nct_ids ?? []).filter((n) => index.has(n) && !index.get(n).removed_at)])].sort();
  const trials = [];
  for (const nct of listed) trials.push(checked(TrialRecordSchema, trialRecord(await readStudy(dataDir, nct)), 'trial'));

  const manifest = checked(ManifestSchema, {
    run_id: runId,
    fetched_at: state.last_collect.at,
    source_db: sourceDb,
    source_api: entities.source,
    ctgov_data_timestamp: state.last_collect.data_timestamp,
    matcher_version: MATCHER_VERSION,
    counts: {
      stored_studies: live.length,
      trials: trials.length,
      trials_listed_only_to_clear_links: listed.length - linked.size,
      company_links: countBy(companyRows, 'confidence'),
      product_links: countBy(productRows, 'confidence'),
      ingredient_links: countBy(ingredientRows, 'confidence'),
      brands_with_trials: new Set(companyRows.map((r) => r.company_id)).size,
      products_with_trials: new Set(productRows.map((r) => r.product_id)).size,
      branded_ingredients_with_trials: new Set(ingredientRows.map((r) => r.branded_ingredient_id)).size,
    },
  }, 'manifest');

  await writeJsonl(join(runDir, 'trials.jsonl'), trials);
  await writeJsonl(join(runDir, 'trial_company_links.jsonl'), companyRows);
  await writeJsonl(join(runDir, 'trial_product_links.jsonl'), productRows);
  await writeJsonl(join(runDir, 'trial_ingredient_links.jsonl'), ingredientRows);
  await writeJsonl(join(runDir, 'review', 'unmatched_industry_sponsors.jsonl'), [...unmatchedSponsors.values()].sort((a, b) => b.trials - a.trials));
  await writeJsonl(join(runDir, 'review', 'ambiguous_sponsors.jsonl'), ambiguous);
  await writeJsonl(join(runDir, 'review', 'rejected_ingredient_terms.jsonl'), rejectedTerms);
  await writeJson(join(runDir, 'manifest.json'), manifest);
  await writeState(dataDir, { ...state, delivered_nct_ids: [...linked].sort(), last_delivery: { run_id: runId, at: new Date().toISOString(), dir: runDir } });
  log.info(manifest.counts, 'delivery written');
  return manifest;
}

function countBy(rows, field) {
  const out = { total: rows.length };
  for (const r of rows) out[r[field]] = (out[r[field]] ?? 0) + 1;
  return out;
}
