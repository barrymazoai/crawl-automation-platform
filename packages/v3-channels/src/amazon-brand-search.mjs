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
// Product pages are fetched only to read Amazon's own brand byline.
export function productAddress(raw) {
  const u = new URL(raw, 'https://www.amazon.com');
  const asin = u.pathname.match(/^\/(?:[^/]+\/)?dp\/([A-Z0-9]{10})\/?$/)?.[1];
  if (!['https://www.amazon.com', 'https://amazon.com'].includes(u.origin) || u.username || u.password || !asin) fail('URL');
  return { asin, url: `https://www.amazon.com/dp/${asin}` };
}
const STORE = /^\/stores\/(?:[^/]+\/)?page\/[0-9A-Fa-f-]{36}\/?$/;
export function productByline(html, asin) {
  if (/validateCaptcha|Robot Check|Enter the characters you see below/i.test(html)) fail('ACCESS_CHALLENGE');
  const { document: d } = parseHTML(html);
  for (const e of d.querySelectorAll('script,style')) e.remove();
  const main = d.querySelector('#ppd');
  const ids = [...(main?.querySelectorAll('#ASIN') ?? [])].map(e => e.getAttribute('value'));
  if (!main || !ids.length || ids.some(x => x !== asin)) fail('PRODUCT_IDENTITY');
  const links = [...main.querySelectorAll('#bylineInfo')];
  if (links.length !== 1) fail('BYLINE_MISSING');
  const brandRaw = text(links[0]), name = brandRaw.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').replace(/^Brand:\s*/i, '').trim();
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) fail('BYLINE_MISSING');
  let storeUrl = null;
  const href = links[0].getAttribute('href');
  if (href) { const s = new URL(href, 'https://www.amazon.com'); if (s.origin === 'https://www.amazon.com' && STORE.test(s.pathname)) storeUrl = s.origin + s.pathname.replace(/\/$/, ''); }
  return { name, brandRaw, storeUrl, title: text(d.querySelector('#productTitle')).slice(0, 300) };
}
// Organic (non-sponsored) result ASINs of a search page, in page order.
export function organicAsins(html, limit = 10) {
  const { document: d } = parseHTML(html);
  for (const e of d.querySelectorAll('script,style')) e.remove();
  const seen = new Set();
  for (const e of d.querySelectorAll('.s-main-slot [data-component-type="s-search-result"][data-asin]')) {
    const asin = e.getAttribute('data-asin') ?? '';
    if (!/^[A-Z0-9]{10}$/.test(asin) || e.querySelector('[data-component-type="s-sponsored-label-marker"],.puis-sponsored-label-text,a[href*="/sspa/click"],a[href*="sponsored-ads.amazon.com"]')) continue;
    seen.add(asin); if (seen.size >= limit) break;
  }
  return [...seen];
}
export const HEALTH_NODE = 'n:3760901';
// Amazon sometimes links a brand option through an SEO path such as
// /Align-Health-Household/s?k=Align&rh=n:3760901,p_123:232433 without i=hpc. Only
// that exact shape inside the Health node is rewritten to the standard address.
export function canonicalOptionHref(raw) {
  const u = new URL(raw, 'https://www.amazon.com');
  if (u.origin === 'https://www.amazon.com' && /^\/[A-Za-z0-9-]+\/s$/.test(u.pathname) && !u.searchParams.has('i') &&
      (u.searchParams.get('rh') ?? '').split(',').includes(HEALTH_NODE)) {
    u.pathname = '/s'; u.searchParams.set('i', 'hpc');
  }
  return u.href;
}
// The department is taken from two places. The search-box dropdown was seen
// showing unrelated specialty-shop labels (e.g. "JAPAN STORE-Kitchen") on pages
// whose selected department in the left panel is Health & Household; either one
// showing Health is accepted, and both are recorded.
function departmentOf(d) {
  const dropdown = d.querySelector('select[name="url"] option[selected]');
  const panel = [...(d.querySelector('#departments')?.querySelectorAll('li') ?? [])]
    .find(li => !li.querySelector('a') && li.querySelector('.a-text-bold'));
  const dropdownValue = dropdown?.getAttribute('value') ?? null, panelSelected = panel ? text(panel) : null;
  return { dropdownValue, dropdownText: text(dropdown), panelSelected,
    health: dropdownValue === 'search-alias=hpc' || panelSelected === 'Health & Household' };
}
export function inspectSearch(html, requestedUrl, names, expected = null) {
  if (/validateCaptcha|Robot Check|Enter the characters you see below/i.test(html)) fail('ACCESS_CHALLENGE');
  const { document: d } = parseHTML(html);
  for (const e of d.querySelectorAll('script,style')) e.remove();
  const departmentState = departmentOf(d);
  if (!departmentState.health) fail('CATEGORY_LOST');
  const accepted = new Set(names.map(normalizeBrand));
  // Only the Brands refinement counts. A Seller (p_6) option with the same text is
  // a different entity; counting it produced 189 false ambiguities and 109 seller-only
  // matches on 2026-09-23.
  const brandFacet = a => { const li = a.closest('li[id]'); return /^(?:p_123|p_4)\//.test(li?.getAttribute('id') ?? ''); };
  const matches = [...d.querySelectorAll('a.s-navigation-item[href]')].filter(a =>
    a.querySelector('input[type="checkbox"]') && brandFacet(a) && accepted.has(normalizeBrand(text(a))));
  if (matches.length !== 1) fail(matches.length ? 'BRAND_AMBIGUOUS' : 'BRAND_FILTER_MISSING');
  const a = matches[0], brandName = text(a), checked = a.querySelector('input').hasAttribute('checked');
  const selected = checked && a.getAttribute('aria-current') === 'true';
  const observedHref = canonicalOptionHref(new URL(a.getAttribute('href'), requestedUrl).href);
  const observedLabel = a.getAttribute('aria-label') ?? '';
  const entry = filterIdentity(expected ? requestedUrl : observedHref);
  if (!expected && (selected || !observedLabel.startsWith('Apply '))) fail('FILTER_STATE');
  if (expected && (!selected || !observedLabel.startsWith('Remove ') || normalizeBrand(brandName) !== normalizeBrand(expected.brandName) ||
      entry.category !== expected.category || entry.brandFilter !== expected.brandFilter || searchAddress(requestedUrl) !== expected.url)) fail('FILTER_STATE');
  const cards = [...d.querySelectorAll('.s-main-slot [data-component-type="s-search-result"][data-asin]')]
    .filter(e => /^[A-Z0-9]{10}$/.test(e.getAttribute('data-asin') ?? ''));
  const organic = cards.filter(e => !e.querySelector('[data-component-type="s-sponsored-label-marker"],.puis-sponsored-label-text,a[href*="/sspa/click"],a[href*="sponsored-ads.amazon.com"]'));
  if (expected && !organic.length) fail('NO_MAIN_RESULTS');
  return { ...entry, brandName, observedHref, observedLabel, selected, department: departmentState.dropdownText, departmentState,
    delivery: text(d.querySelector('#glow-ingress-block')), mainResultCards: cards.length,
    organicResultCards: organic.length, catalogEnumerationComplete: false };
}
