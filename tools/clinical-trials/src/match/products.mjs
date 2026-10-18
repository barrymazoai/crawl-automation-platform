// Intervention name → Supply Smart product, looked for only among the products of a brand the
// trial is already linked to. Words are compared as sets after the brand's own words, sizes,
// counts and filler are removed; a form word stays ("PMS Capsule" and "PMS Gummy" are two products).
//
//   same words                                  high (medium when that is one short word)
//   one side contains the other, 2+ words       medium
//   Jaccard >= 0.6 with 2+ shared words         low
//   product words all in the title, 2+ words    low (basis "title")
//
// More than 25 products tied for one intervention means the words don't tell them apart: low.
// So is a collaborator brand's product unless the intervention names the brand.
import { core, legalStripped, words } from './names.mjs';
import { interventions, isPlacebo } from '../ctgov/study.mjs';
import { weaker } from './companies.mjs';

const FILLER = new Set([
  'the', 'and', 'of', 'for', 'with', 'a', 'an', 'by', 'in', 'to', 'plus', 'supplement', 'supplements', 'dietary',
  'nutritional', 'product', 'pack', 'packs', 'serving', 'servings', 'count', 'ct', 'mg', 'mcg', 'g', 'kg', 'oz', 'fl',
  'ml', 'l', 'lb', 'lbs', 'iu', 'size', 'bottle', 'bottles', 'value', 'new', 'pouch', 'jar', 'tub', 'box', 'bag',
  'x', 'per', 'day', 'supply',
]);

/** Plural and singular meet ("capsules" / "capsule"); numbers and sizes go. */
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const isSize = (w) => /^\d+(\.\d+)?$/.test(w) || /^\d+(\.\d+)?(mg|mcg|g|kg|oz|ml|l|ct|lb|lbs|iu|x|pk|pack|count|day|serving)s?$/.test(w);

export function significantWords(text, brandWords) {
  return new Set(words(text).filter((w) => !FILLER.has(w) && !isSize(w) && !brandWords.has(w)).map(stem));
}

function compare(productWords, textWords) {
  const shared = [...productWords].filter((w) => textWords.has(w)).length;
  if (productWords.size === 0 || textWords.size === 0 || shared === 0) return null;
  if (shared === productWords.size && shared === textWords.size) {
    const short = shared === 1 && [...productWords][0].length < 4;
    return short ? 'medium' : 'high';
  }
  if (shared >= 2 && (shared === productWords.size || shared === textWords.size)) return 'medium';
  if (shared >= 2 && shared / (productWords.size + textWords.size - shared) >= 0.6) return 'low';
  return null;
}

const RANK = { high: 3, medium: 2, low: 1 };

/**
 * Product links of one study. `companyLinks` are the study's brand links (only high/medium ones
 * are searched); `productsByCompany` maps company id → [{ id, name }].
 */
export function matchProducts(study, companyLinks, productsByCompany) {
  const out = new Map();
  for (const link of companyLinks) {
    if (link.confidence === 'low') continue;
    const products = productsByCompany.get(link.company.id) ?? [];
    if (products.length === 0) continue;
    const brandWords = new Set([...words(legalStripped(link.company.name)), ...words(core(link.company.name))]);
    const coreWords = words(core(link.company.name));
    const prepared = products.map((p) => ({ product: p, words: significantWords(p.name, brandWords) }));

    const candidates = [];
    for (const iv of interventions(study)) {
      if (isPlacebo(iv)) continue;
      candidates.push({ basis: 'intervention_name', text: iv.name, ivName: iv.name });
      for (const other of iv.otherNames ?? []) candidates.push({ basis: 'intervention_other_name', text: other, ivName: iv.name });
    }
    const title = study.protocolSection?.identificationModule?.briefTitle;
    let found = 0;

    for (const c of candidates) {
      const textWords = significantWords(c.text, brandWords);
      const scored = prepared.map((p) => ({ ...p, tier: compare(p.words, textWords) })).filter((p) => p.tier);
      if (scored.length === 0) continue;
      const top = Math.max(...scored.map((p) => RANK[p.tier]));
      const best = scored.filter((p) => RANK[p.tier] === top);
      // A collaborator often only supplies product; "Nicotinamide" in a NOW Foods-supported trial does
      // not say which NOW Foods SKU was used unless the intervention names the brand.
      const brandNamed = link.role === 'lead_sponsor' || coreWords.some((w) => words(c.text).includes(w));
      for (const p of best) {
        const confidence = weaker(best.length > 25 || !brandNamed ? 'low' : p.tier, link.confidence);
        offer(out, { product: p.product, intervention_name: c.ivName, basis: c.basis, confidence, company: link.company });
        found += 1;
      }
    }
    if (title && found === 0) {
      const titleWords = significantWords(title, brandWords);
      const hits = prepared.filter((p) => p.words.size >= 2 && [...p.words].every((w) => titleWords.has(w)));
      if (hits.length && hits.length <= 25) {
        for (const p of hits) offer(out, { product: p.product, intervention_name: null, basis: 'title', confidence: 'low', company: link.company });
      }
    }
  }
  return [...out.values()];
}

function offer(out, link) {
  const prev = out.get(link.product.id);
  if (!prev || RANK[link.confidence] > RANK[prev.confidence]) out.set(link.product.id, link);
}
