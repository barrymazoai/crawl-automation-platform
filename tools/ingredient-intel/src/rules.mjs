// Which Supply Smart ingredient names are a branded ingredient, and which ®/™ spellings in a name
// still need a judgement. Both rules are ported unchanged from the 2026-10-16 supplier-intel run
// (~/Documents/supplier-intel/scripts/ss_ingredient_match.py and ss_marked_candidates.py), which built
// the 14,600 links Supply Smart holds; src/rules-check.mjs replays them against that run's files.
// One addition (2026-10-26, still 14,600 on the 10-16 files): invisible characters are ignored, so
// "VEGADELI\u200b\u200bGHT®" in a label line is VegaDELIGHT.
//
// A name matches a branded ingredient when one of its aliases (or its canonical name, or a part of an
// "A / B" name) appears as a whole word, separators "-" and " " optional. A strict alias counts only
// when ® / ™ / (r) / (tm) follows it, or when it is written in capitals and is at most 4 characters:
// short aliases (≤ 3 letters, no digit), aliases the 10-15 count marked as "marked only", the words
// ribose / spectra / s7, and words of another ingredient's generic name (krill, ubiquinol, …).
import AhoCorasick from 'modern-ahocorasick';

export const RULES_VERSION = 'ss-ingredient-match-2026-10-26';

export const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// What a match ignores: case, and "-" / " " where the alias has one (they are optional there).
const squeeze = (s) => s.toLowerCase().replace(/[- ]/g, '');

const GENERIC_PARTS = new Set(['q10', 'coq10', 'ubiquinol', 'mk7', 'k2']);
const ALWAYS_STRICT = new Set(['ribose', 'spectra', 's7']);
// As in the original: the mark test is case-sensitive, so "(r)" / "(tm)" count and "(R)" / "(TM)" don't.
const MARK_AFTER = /^\s*(?:®|™|\((?:r|tm)\))/;
const genericWords = (text) => new Set((text ?? '').toLowerCase().match(/[a-z][a-z'-]+/g) ?? []);
const isUpper = (s) => s !== s.toLowerCase() && s === s.toUpperCase();
// Zero-width spaces and joiners, word joiner, byte-order mark, soft hyphen: invisible in a label, copied in by OCR.
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
const escapeChar = (c) => (c === '-' || c === ' ' ? '[- ]?' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * registry: [{ id, ingredient, generic_name, aliases: [], marked_only_aliases: [] }].
 * Returns hits(text) → Set of registry ids, each id as the registry gives it (duplicates are not resolved here).
 */
export function createMatcher(registry) {
  const generic = new Map();
  for (const r of registry) for (const w of genericWords(r.generic_name)) generic.set(w, (generic.get(w) ?? 0) + 1);

  const patterns = [];
  for (const r of registry) {
    // Canonical name and the parts of "A / B" names (HN001 / HN019); a parenthetical part (a species) and a
    // generic part (Q10 in "Kaneka Ubiquinol / Q10") is not a brand name.
    const parts = r.ingredient
      .replace(/\s*\([^)]*\)/g, '')
      .split(/\s*\/\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
    const names = new Set([r.ingredient, ...parts.filter((p) => !GENERIC_PARTS.has(key(p)))]);
    const aliases = new Set([...r.aliases, ...names]);
    const markedOnly = new Set(r.marked_only_aliases);
    const own = genericWords(r.generic_name);
    for (const alias of aliases) {
      const k = key(alias);
      if (k.length < 2) continue;
      const lower = alias.toLowerCase();
      const digit = /\d/.test(alias);
      const strict =
        (k.length <= 3 && !digit) ||
        markedOnly.has(lower) ||
        ALWAYS_STRICT.has(lower) ||
        (!digit && (generic.get(lower) ?? 0) - (own.has(lower) ? 1 : 0) > 0);
      const body = [...alias].map(escapeChar).join('');
      patterns.push({ id: r.id, alias, strict, shortKey: k.length <= 4, re: new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi') });
    }
  }

  // Aho-Corasick finds which aliases can occur at all (their squeezed form is in the squeezed text); only
  // those run their regular expression. A regex match always implies the squeezed hit, so nothing is lost.
  const byKeyword = new Map();
  for (const p of patterns) {
    const s = squeeze(p.alias);
    if (!byKeyword.has(s)) byKeyword.set(s, []);
    byKeyword.get(s).push(p);
  }
  const keywords = [...byKeyword.keys()];
  const ac = new AhoCorasick(keywords);

  function hits(raw) {
    const text = raw.replace(INVISIBLE, '');
    const out = new Set();
    const candidates = new Set();
    for (const m of ac.search(squeeze(text))) for (const p of byKeyword.get(m.pattern)) candidates.add(p);
    for (const p of candidates) {
      if (out.has(p.id)) continue;
      p.re.lastIndex = 0;
      for (const m of text.matchAll(p.re)) {
        const end = m.index + m[0].length;
        if (!p.strict || MARK_AFTER.test(text.slice(end, end + 6)) || (isUpper(m[0]) && p.shortKey)) {
          out.add(p.id);
          break;
        }
      }
    }
    return out;
  }

  return { hits, patterns: patterns.length, keywords: keywords.length };
}

// ®/™ spellings: up to 31 characters before the mark, leading filler words dropped; certification and capsule
// words, one-character spellings and phrases of more than 4 words are not spellings of an ingredient.
const MARKED = /([A-Za-z0-9][A-Za-z0-9\-.'&+ ]{0,30}?)\s*(®|™|\((?:R|TM)\))/g;
const LEAD =
  /^(?:(?:as|from|with|contains?|and|of|the|inc\.?|including|plus|patented|clinically|studied|proprietary|organic|branded|a|an|by|in|is|our)\s+)+/i;
const CERT =
  /fsc|certified|fair ?trade|b[- ]?corp|non[- ]?gmo|usda|kosher|halal|vegan|gluten|nsf|informed|\.org|\.com|www|veg(etarian)? ?caps|drcaps|vcaps|capsugel|plantgel|softgel|gelcap/i;

export function markedSpellings(name) {
  const out = [];
  for (const m of name.matchAll(MARKED)) {
    const t = m[1].trim().toLowerCase().replace(/\s+/g, ' ').replace(LEAD, '');
    if (key(t).length < 2 || CERT.test(t) || t.split(' ').length > 4) continue;
    out.push(t);
  }
  return out;
}
