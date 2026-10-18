// Trial sponsor / collaborator → Supply Smart company (brand). Only the sponsor fields are read:
// a full-text hit is never a brand link ("Seed Health" in full text matches "Seed Grant").
//
//   sponsor_exact  the sponsor's name without legal forms equals the company's   high; medium if short, low if one
//                  ordinary word ("Seed" = "SEED Co. Ltd.", a contact-lens maker)
//   sponsor_alias  the name a "dba" / parenthesis gives equals the company's     high (medium if weak)
//                  equal only after dropping business words                     high if the core is long, medium,
//                                                                               low when it is one ordinary word
//   manual         listed in <data-dir>/aliases.json                            high
//
// A full-name match beats a core-only one; several companies tied on the best match are all low
// (Supply Smart shows low links only after review).
import { core, coreIsOrdinaryWord, coreIsWeak, legalStripped, nameVariants } from './names.mjs';
import { parties } from '../ctgov/study.mjs';

const RANK = { high: 3, medium: 2, low: 1 };
export const weaker = (a, b) => (RANK[a] <= RANK[b] ? a : b);

export function createCompanyMatcher(companies, manualAliases = []) {
  const exact = new Map();
  const byCore = new Map();
  const add = (map, key, company) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(company.id, company);
  };
  for (const company of companies) {
    for (const variant of nameVariants(company.name)) {
      add(exact, legalStripped(variant), company);
      add(byCore, core(variant), company);
    }
  }
  const manual = new Map(manualAliases.map((a) => [legalStripped(a.sponsor), a]));
  const byId = new Map(companies.map((c) => [c.id, c]));

  /** Every company this party name may be, best basis first. */
  function matchName(name) {
    const m = manual.get(legalStripped(name));
    if (m) return m.company_id ? [{ company: byId.get(m.company_id) ?? { id: m.company_id, name: m.company_name ?? null }, basis: 'manual', confidence: 'high' }] : [];
    const variants = nameVariants(name);
    const whole = legalStripped(variants[0]);
    const found = new Map();
    // strength 2: a full name equals; 1: only the cores do.
    const offer = (company, basis, confidence, strength) => {
      const prev = found.get(company.id);
      if (!prev || strength > prev.strength || (strength === prev.strength && RANK[confidence] > RANK[prev.confidence])) {
        found.set(company.id, { company, basis, confidence, strength });
      }
    };
    for (const variant of variants) {
      const stripped = legalStripped(variant);
      const c = core(variant);
      for (const company of exact.get(stripped)?.values() ?? []) {
        // The whole name, or the name a "dba" / parenthesis states outright.
        const key = c || stripped;
        offer(company, stripped === whole ? 'sponsor_exact' : 'sponsor_alias', coreIsOrdinaryWord(key) && stripped === whole ? 'low' : coreIsWeak(key) ? 'medium' : 'high', 2);
      }
      for (const company of byCore.get(c)?.values() ?? []) {
        const long = c.split(' ').length > 1 || c.length >= 8;
        offer(company, 'sponsor_alias', coreIsWeak(c) ? 'low' : long ? 'high' : 'medium', 1);
      }
    }
    // Only the best kind of match counts; several companies tied on it are all low.
    const list = [...found.values()];
    const top = Math.max(0, ...list.map((x) => x.strength));
    const best = list.filter((x) => x.strength === top);
    if (best.length > 1) return best.map((x) => ({ ...x, confidence: 'low', ambiguous: best.length }));
    return best;
  }

  /** Company links of one study: { company, role, matched_name, basis, confidence }. */
  function matchStudy(study) {
    const links = new Map();
    for (const party of parties(study)) {
      for (const hit of matchName(party.name)) {
        const next = { ...hit, role: party.role, matched_name: party.name, party_class: party.class };
        const prev = links.get(hit.company.id);
        if (!prev) {
          links.set(hit.company.id, next);
          continue;
        }
        // Lead sponsor and collaborator at once: one link, the lead role, the better match.
        const best = RANK[next.confidence] > RANK[prev.confidence] ? next : prev;
        links.set(hit.company.id, { ...best, role: prev.role === 'lead_sponsor' ? 'lead_sponsor' : next.role });
      }
    }
    return [...links.values()];
  }

  return { matchName, matchStudy };
}
