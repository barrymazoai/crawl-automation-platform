// Name normalization shared by the relevance filter and the matchers. Everything is literal:
// no fuzzy distance, no stemming. A "core" name drops legal forms and generic business words,
// so "Athletic Greens (USA), Inc." and "Athletic Greens International" meet at "athletic greens".

/** Lowercase, accents and ®/™ removed, "&" → "and", punctuation → space, whitespace collapsed. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[®™©℠]/g, ' ')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export const words = (text) => (normalize(text) ? normalize(text).split(' ') : []);

const LEGAL_FORMS = new Set([
  'inc', 'incorporated', 'llc', 'l', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'lp', 'llp',
  'gmbh', 'ag', 'kg', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv', 'ab', 'as', 'oy', 'pty', 'pte', 'kk', 'sl',
  'the',
]);

/** Words that say what kind of business it is, not which one */
const BUSINESS_WORDS = new Set([
  'usa', 'us', 'america', 'americas', 'north', 'international', 'intl', 'global', 'worldwide', 'holdings', 'holding',
  'group', 'enterprises', 'brands', 'brand', 'products', 'health', 'healthcare', 'nutrition', 'nutritionals',
  'nutraceuticals', 'naturals', 'natural', 'labs', 'lab', 'laboratories', 'laboratory', 'research', 'sciences',
  'science', 'pharma', 'pharmaceuticals', 'pharmaceutical', 'wellness', 'supplements', 'industries', 'technologies',
  'technology', 'biotech', 'biosciences', 'inc', 'and', 'of',
]);

/** "Natals, Inc. dba Ritual" → ["Natals, Inc.", "Ritual"]; parenthesised parts become their own names too. */
export function nameVariants(name) {
  const out = new Set([String(name)]);
  for (const part of String(name).split(/\b(?:d\/b\/a|dba|doing business as|a\/k\/a|aka|formerly|f\/k\/a)\b/i)) {
    if (part.trim()) out.add(part.trim());
  }
  for (const v of [...out]) {
    const outside = v.replace(/\([^)]*\)/g, ' ').trim();
    if (outside) out.add(outside);
  }
  return [...out];
}

/** Full name without legal forms: "garden of life" for "Garden of Life LLC". */
export function legalStripped(name) {
  const w = words(name.replace(/\([^)]*\)/g, ' '));
  while (w.length > 1 && LEGAL_FORMS.has(w.at(-1))) w.pop();
  const kept = w.filter((x, i) => !(LEGAL_FORMS.has(x) && (i === 0 || i === w.length - 1)));
  return kept.join(' ');
}

/** Distinctive words only: "athletic greens" for "Athletic Greens (USA), Inc." */
export function core(name) {
  return words(legalStripped(name))
    .filter((w) => !LEGAL_FORMS.has(w) && !BUSINESS_WORDS.has(w))
    .join(' ');
}

/**
 * The words to search the registry's sponsor field with: the name as written (apostrophes, "of" kept),
 * without parentheses, a trailing legal form or trailing business words. "Thorne Research" → "Thorne",
 * "Garden of Life LLC" → "Garden of Life", "Life Extension(R)" → "Life Extension".
 */
export function searchName(name) {
  let parts = String(name).replace(/\([^)]*\)/g, ' ').replace(/[®™"]/g, ' ').replace(/,/g, ' ').trim().split(/\s+/);
  const plain = (w) => normalize(w);
  while (parts.length > 1 && (LEGAL_FORMS.has(plain(parts.at(-1))) || plain(parts.at(-1)) === '')) parts = parts.slice(0, -1);
  while (parts.length > 1 && BUSINESS_WORDS.has(plain(parts.at(-1)))) parts = parts.slice(0, -1);
  return parts.join(' ');
}

/** One ordinary English word ("seed", "ritual"): equal names still don't say it is the same company. */
export const coreIsOrdinaryWord = (c) => !c.includes(' ') && COMMON_SINGLE_WORDS.has(c);

/** A core of one short or ordinary word ("seed", "ritual", "life") identifies nothing on its own. */
export function coreIsWeak(c) {
  const parts = c.split(' ').filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.length > 1) return parts.join('').length < 6;
  return parts[0].length < 7 || COMMON_SINGLE_WORDS.has(parts[0]);
}

const COMMON_SINGLE_WORDS = new Set([
  'seed', 'ritual', 'life', 'garden', 'nature', 'natures', 'vital', 'pure', 'essential', 'balance', 'simply',
  'origin', 'genesis', 'harmony', 'nourish', 'premier', 'element', 'elements', 'pioneer', 'liberty', 'summit',
]);

/** Word n-grams of a text (1…max words), for exact phrase lookups against a term index. */
export function phrases(text, max = 6) {
  const w = words(text);
  const out = [];
  for (let i = 0; i < w.length; i += 1) {
    for (let n = 1; n <= max && i + n <= w.length; n += 1) out.push({ phrase: w.slice(i, i + n).join(' '), at: i, n });
  }
  return out;
}

/** The sentence-sized piece of `text` around the first whole-word occurrence of `term`, for evidence. */
export function quoteAround(text, term, radius = 120) {
  const source = String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const pattern = normalize(term).split(' ').map(escapeRegExp).join('[^a-zA-Z0-9]+');
  const match = new RegExp(`(^|[^a-zA-Z0-9])(${pattern})(?![a-zA-Z0-9])`, 'i').exec(source);
  if (!match) return source.slice(0, radius * 2);
  const start = Math.max(0, match.index - radius);
  const end = Math.min(source.length, match.index + match[0].length + radius);
  return `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
