import { parseHTML } from 'linkedom';

export const normalizeBrand = s => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
const fail = code => { throw Error('BRAND_SEARCH.' + code); };
const text = e => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
export function searchAddress(raw) {
  const u = new URL(raw, 'https://www.amazon.com');
  if (u.origin !== 'https://www.amazon.com' || u.username || u.password || u.pathname !== '/s' ||
      u.searchParams.get('i') !== 'hpc' || !u.searchParams.get('k') || u.searchParams.has('page')) fail('URL');
  const result = new URL('https://www.amazon.com/s');
  for (const k of ['k', 'i', 'rh']) if (u.searchParams.has(k)) result.searchParams.set(k, u.searchParams.get(k));
  if (u.searchParams.has('rh')) result.searchParams.set('dc', '');
  return result.href;
}
export function filterIdentity(raw) {
  const u = new URL(searchAddress(raw)), parts = (u.searchParams.get('rh') ?? '').split(',');
  const categories = parts.filter(p => /^n:\d+$/.test(p));
  const brands = parts.filter(p => /^p_123:\d+$/.test(p) || /^p_4:[^,|]+$/.test(p));
  if (parts.length !== 2 || categories.length !== 1 || brands.length !== 1) fail('FILTER_SCOPE');
  return { category: categories[0], brandFilter: brands[0], url: u.href };
}
export function inspectSearch(html, requestedUrl, names, expected = null) {
  if (/validateCaptcha|Robot Check|Enter the characters you see below/i.test(html)) fail('ACCESS_CHALLENGE');
  const { document: d } = parseHTML(html);
  for (const e of d.querySelectorAll('script,style')) e.remove();
  const department = d.querySelector('select[name="url"] option[selected]');
  if (department?.getAttribute('value') !== 'search-alias=hpc') fail('CATEGORY_LOST');
  const accepted = new Set(names.map(normalizeBrand));
  const matches = [...d.querySelectorAll('a.s-navigation-item[href]')].filter(a =>
    a.querySelector('input[type="checkbox"]') && accepted.has(normalizeBrand(text(a))));
  if (matches.length !== 1) fail(matches.length ? 'BRAND_AMBIGUOUS' : 'BRAND_FILTER_MISSING');
  const a = matches[0], brandName = text(a), checked = a.querySelector('input').hasAttribute('checked');
  const selected = checked && a.getAttribute('aria-current') === 'true';
  const observedHref = new URL(a.getAttribute('href'), requestedUrl).href;
  const observedLabel = a.getAttribute('aria-label') ?? '';
  const entry = filterIdentity(expected ? requestedUrl : observedHref);
  if (!expected && (selected || !observedLabel.startsWith('Apply '))) fail('FILTER_STATE');
  if (expected && (!selected || !observedLabel.startsWith('Remove ') || normalizeBrand(brandName) !== normalizeBrand(expected.brandName) ||
      entry.category !== expected.category || entry.brandFilter !== expected.brandFilter || searchAddress(requestedUrl) !== expected.url)) fail('FILTER_STATE');
  const cards = [...d.querySelectorAll('.s-main-slot [data-component-type="s-search-result"][data-asin]')]
    .filter(e => /^[A-Z0-9]{10}$/.test(e.getAttribute('data-asin') ?? ''));
  const organic = cards.filter(e => !e.querySelector('[data-component-type="s-sponsored-label-marker"],.puis-sponsored-label-text,a[href*="/sspa/click"],a[href*="sponsored-ads.amazon.com"]'));
  if (expected && !organic.length) fail('NO_MAIN_RESULTS');
  return { ...entry, brandName, observedHref, observedLabel, selected, department: text(department),
    delivery: text(d.querySelector('#glow-ingress-block')), mainResultCards: cards.length,
    organicResultCards: organic.length, catalogEnumerationComplete: false };
}
