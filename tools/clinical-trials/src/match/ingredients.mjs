// Branded ingredient name / alias → trial, by whole-phrase occurrence in intervention names, other
// names, descriptions, arm descriptions, titles or keywords (never summaries or eligibility).
//
//   distinctive term in an intervention or arm field   high
//   distinctive term only in a title / keyword         medium
//   a word that is not a brand on its own — English words ("collective", "phase 2", "krill", "ribose"),
//   a term that mostly occurs in trials testing no supplement ("activin", "somato-sensory"), or the initials
//   of the ingredient's own generic name ("CLA", conjugated linoleic acid) — counts only when it is written
//   with ®/™ in that field (as above), or the supplier is named in the record (→ medium);
//   a strain code ("La-14", "BB-12") counts with a word of the generic name in the same field (the
//   species) or the supplier's name in the record → medium.
//   Anything else is rejected and kept for review. (2026-10-26: the first push linked 1,037 trials, most
//   of them through such words; owner: take them back and fix the rule.)
//
// Generic and active-compound matches (KAN-213, Lavitol → taxifolin) are not made here yet:
// Supply Smart has no active_compounds field to read them from.
import englishWords from 'an-array-of-english-words' with { type: 'json' };
import { core, legalStripped, markedAfter, nameVariants, normalize, phrases, quoteAround, words } from './names.mjs';
import { interventions, isDietarySupplement, isPlacebo, namedFields, parties } from '../ctgov/study.mjs';

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

const ENGLISH = new Set(englishWords);
/**
 * Every word an English word, a number or a single letter: "phase 2", "life s", "collective". A strain code
 * whose letters are not a word of 3 letters or more stays a code: "La-14", "Bi-07", "GR-1".
 */
export function isOrdinaryTerm(term) {
  const t = normalize(term);
  const letters = t.match(/^[a-z]+/)?.[0] ?? '';
  if (STRAIN.test(t)) return letters.length >= 3 && ENGLISH.has(letters);
  return t.split(' ').every((w) => w.length <= 1 || /^\d+$/.test(w) || ENGLISH.has(w) || ORDINARY.has(w));
}
/** "cla" for "conjugated linoleic acid (60%)": the initials of consecutive words of the generic name. */
function isInitialsOf(term, genericName) {
  const t = normalize(term).replace(/ /g, '');
  const initials = words(genericName ?? '').filter((w) => /^[a-z]/.test(w)).map((w) => w[0]).join('');
  return /^[a-z]{2,4}$/.test(t) && initials.includes(t);
}
// A term in at least this many stored trials, under a tenth of them testing a dietary supplement, is a
// biomedical word ("activin": 43 trials, 2 supplements); brands such as MitoQ are mostly tested as supplements,
// and a few brands are tested as drugs ("Sunphenon": 13 trials, 2 supplements).
const BIOMEDICAL = { minTrials: 10, maxSupplementShare: 0.1 };

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
      const weak = isWeakTerm(term);
      const ordinary = isOrdinaryTerm(term) || isInitialsOf(term, bi.genericName);
      index.get(term).push({ bi, basis, weak, ordinary, context, supplierCores });
    }
  }

  // How many stored trials each term occurs in, and how many of them test a dietary supplement: count() runs
  // over every study before the first matchStudy().
  const seenIn = new Map();
  function count(study) {
    const found = new Set();
    for (const f of namedFields(study)) for (const { phrase } of phrases(f.text)) if (index.has(phrase)) found.add(phrase);
    const supplement = isDietarySupplement(study);
    for (const t of found) {
      const c = seenIn.get(t) ?? { trials: 0, supplement: 0 };
      c.trials += 1;
      if (supplement) c.supplement += 1;
      seenIn.set(t, c);
    }
  }
  const biomedical = (term) => {
    const c = seenIn.get(term);
    return !!c && c.trials >= BIOMEDICAL.minTrials && c.supplement < c.trials * BIOMEDICAL.maxSupplementShare;
  };

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
          const notABrand = entry.ordinary ? 'not a brand on its own' : biomedical(phrase) ? 'mostly in trials testing no supplement' : null;
          if (notABrand) {
            const supplierSeen = entry.supplierCores.some((s) => allText.includes(` ${s} `));
            if (!markedAfter(f.text, phrase)) {
              if (!supplierSeen) {
                rejected.push({ nct_id: null, branded_ingredient_id: bi.id, name: bi.name, term: phrase, field: f.field, reason: `"${phrase}" is ${notABrand}: no ®/™ and no supplier name in the record` });
                continue;
              }
              confidence = 'medium';
              reviewNote = `"${phrase}" is ${notABrand}; accepted with the supplier name in the record`;
            }
          } else if (entry.weak) {
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

  return { count, matchStudy };
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
