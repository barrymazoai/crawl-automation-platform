// Branded ingredient name / alias → trial, by whole-phrase occurrence in intervention names, other
// names, descriptions, arm descriptions, titles or keywords (never summaries or eligibility).
//
//   distinctive term in an intervention or arm field   high
//   distinctive term only in a title / keyword         medium
//   weak term (≤4 letters, a strain code like "La-14", or an ordinary word) only counts with
//   context: a word of the generic name in the same field, or the supplier's name in the record → medium;
//   without context it is rejected and kept for review.
//
// Generic and active-compound matches (KAN-213, Lavitol → taxifolin) are not made here yet:
// Supply Smart has no active_compounds field to read them from.
import { core, legalStripped, nameVariants, normalize, phrases, quoteAround, words } from './names.mjs';
import { interventions, isPlacebo, namedFields, parties } from '../ctgov/study.mjs';

const ORDINARY = new Set([
  'liver', 'inside', 'peak', 'krill', 'spectra', 'phase', 'pure', 'active', 'balance', 'focus', 'calm', 'sleep',
  'energy', 'immune', 'vital', 'prime', 'elite', 'boost', 'restore', 'protect', 'nutrim', 'ultra', 'max', 'plus',
  'complete', 'advanced', 'original', 'natural', 'fiber', 'protein', 'collagen',
]);
const STRAIN = /^[a-z]{1,5} ?\d{1,5}[a-z]?$/;

export function isWeakTerm(term) {
  const t = normalize(term);
  return t.replace(/ /g, '').length <= 4 || STRAIN.test(t) || (!t.includes(' ') && ORDINARY.has(t));
}

const strength = (confidence, basis) => (confidence === 'high' ? 2 : 0) + (basis === 'brand' ? 1 : 0);

export function createIngredientMatcher(brandedIngredients) {
  const index = new Map();
  for (const bi of brandedIngredients) {
    const terms = new Map();
    for (const v of nameVariants(bi.name)) terms.set(normalize(v.replace(/\([^)]*\)/g, ' ')), 'brand');
    for (const alias of bi.aliases ?? []) {
      for (const v of nameVariants(alias)) {
        const t = normalize(v.replace(/\([^)]*\)/g, ' '));
        if (!terms.has(t)) terms.set(t, 'alias');
      }
    }
    // Generic name words of at least 5 letters, and the supplier's names, are the context for weak terms.
    const context = new Set(words(bi.genericName ?? '').filter((w) => w.length >= 5 && !['extract', 'powder', 'complex'].includes(w)));
    const supplierCores = bi.supplier ? [core(bi.supplier.name), legalStripped(bi.supplier.name)].filter(Boolean) : [];
    for (const [term, basis] of terms) {
      if (term.replace(/ /g, '').length < 3) continue;
      if (!index.has(term)) index.set(term, []);
      index.get(term).push({ bi, basis, weak: isWeakTerm(term), context, supplierCores });
    }
  }

  /** Ingredient links and rejected weak hits of one study. */
  function matchStudy(study) {
    const fields = namedFields(study);
    const allText = ` ${fields.map((f) => normalize(f.text)).join(' ')} `;
    const lead = parties(study).find((p) => p.role === 'lead_sponsor');
    const nonPlacebo = interventions(study).filter((iv) => !isPlacebo(iv));
    const links = new Map();
    const rejected = [];

    for (const f of fields) {
      for (const { phrase } of phrases(f.text)) {
        for (const entry of index.get(phrase) ?? []) {
          const { bi } = entry;
          const inIntervention = f.field.startsWith('interventions') || f.field.startsWith('armGroups');
          let confidence = inIntervention ? 'high' : 'medium';
          let reviewNote = null;
          if (entry.weak) {
            // The species / generic word must be in the same field ("L. acidophilus La-14"); the
            // supplier may be named anywhere in the record.
            const fieldText = ` ${normalize(f.text)} `;
            const supplierSeen = entry.supplierCores.some((s) => allText.includes(` ${s} `));
            const genericSeen = [...entry.context].some((w) => fieldText.includes(` ${w} `));
            if (!supplierSeen && !genericSeen) {
              rejected.push({ nct_id: null, branded_ingredient_id: bi.id, name: bi.name, term: phrase, field: f.field, reason: 'weak term without supplier or generic-name context' });
              continue;
            }
            confidence = 'medium';
            reviewNote = `weak term "${phrase}" accepted with ${supplierSeen ? 'supplier name' : 'generic name'} in the record`;
          }
          // One link per branded ingredient (Supply Smart keeps one row per pair): the strongest evidence,
          // high before medium, then the brand name before an alias, then the first one found.
          const prev = links.get(bi.id);
          if (prev && strength(prev.confidence, prev.match_basis) >= strength(confidence, entry.basis)) continue;
          links.set(bi.id, {
            bi,
            match_basis: entry.basis,
            matched_term: phrase,
            matched_field: f.field,
            evidence_quote: quoteAround(f.text, phrase),
            role: roleOf(f, phrase, nonPlacebo),
            sponsor_is_supplier: sponsorIsSupplier(lead, bi),
            confidence,
            review_note: reviewNote,
          });
        }
      }
    }
    return { links: [...links.values()], rejected };
  }

  return { matchStudy };
}

/** sole: the only tested product; combination: named with other actives; unclear otherwise. */
function roleOf(field, term, nonPlacebo) {
  if (!field.intervention) return 'unclear';
  const name = normalize(field.intervention.name);
  const rest = name.replace(term, ' ').trim();
  if (/\+|\band\b|\bwith\b|,|\//.test(field.intervention.name) && rest.split(' ').filter((w) => w.length > 2).length > 0) return 'combination';
  return nonPlacebo.length === 1 ? 'sole' : 'unclear';
}

/** true / false, or null when an industry sponsor's ties to the supplier are unknown. */
function sponsorIsSupplier(lead, bi) {
  if (!lead || !bi.supplier) return null;
  const sponsor = [core(lead.name), legalStripped(lead.name)];
  const supplier = [core(bi.supplier.name), legalStripped(bi.supplier.name)];
  if (sponsor.some((s) => s && supplier.includes(s))) return true;
  return lead.class === 'INDUSTRY' ? null : false;
}
