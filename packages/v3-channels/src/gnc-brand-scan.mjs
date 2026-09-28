import { parseHTML } from 'linkedom';

// GNC brand scan: every product of one GNC brand page (/brands/<slug>/), newest first. Checked through ScraperAPI on
// 2026-09-28: plain HTML (no render), no challenge, sz=200 returns a whole brand on one page (Optimum Nutrition 48/48),
// and the page states its total ("48 Results", data-actual-productcount), so a scan can prove it read every tile.
export const GNC_SORT = 'new-arrivals';
export const GNC_PAGE_SIZE = 200;
const fail = code => { throw Error('BRAND_SCAN.' + code); };
const text = e => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
export function gncScanAddress(raw) {
  const u = new URL(raw, 'https://www.gnc.com');
  if (!['https://www.gnc.com', 'https://gnc.com'].includes(u.origin) || u.username || u.password) fail('URL');
  const slug = u.pathname.match(/^\/brands\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/)?.[1]; if (!slug) fail('URL');
  const srule = u.searchParams.get('srule'); if (srule !== null && srule !== GNC_SORT) fail('URL');
  const sz = u.searchParams.get('sz'); if (sz !== null && sz !== String(GNC_PAGE_SIZE) && u.searchParams.has('start')) fail('URL');
  const start = Number(u.searchParams.get('start') ?? 0);
  if (!Number.isInteger(start) || start < 0 || start % GNC_PAGE_SIZE || start / GNC_PAGE_SIZE >= 50) fail('URL');
  const r = new URL(`https://www.gnc.com/brands/${slug}/`);
  r.searchParams.set('srule', GNC_SORT); r.searchParams.set('start', String(start)); r.searchParams.set('sz', String(GNC_PAGE_SIZE));
  return { url: r.href, kind: 'gnc-brand', slug, page: start / GNC_PAGE_SIZE + 1 };
}
export const gncScanPageUrl = (base, page) => { const a = gncScanAddress(base); const u = new URL(a.url); u.searchParams.set('start', String((page - 1) * GNC_PAGE_SIZE)); return gncScanAddress(u.href).url; };
export function gncScanPage(html, requestedUrl) {
  const address = gncScanAddress(requestedUrl);
  const { document: d } = parseHTML(html);
  for (const e of d.querySelectorAll('script,style,noscript')) e.remove();
  // A real challenge page has no product grid and a verification form; the RateLimiter URL in the site config is not one.
  const grid = d.querySelector('.search-result-items');
  if (!grid && /verify (?:that )?you are (?:a )?human|px-captcha|captcha-container|Access Denied/i.test(html)) fail('ACCESS_CHALLENGE');
  const all = grid ? [...grid.querySelectorAll('li.grid-tile')] : [];
  const items = new Map(), kinds = new Map(), organic = [];
  // A product tile carries data-itemid and its product page link (/<category>/<id>.html). The id is a 6-digit SKU, or a
  // family id (e.g. GNCTotalLeanLeanShake12Pack: one product with several flavours/sizes behind "View Options").
  // Promotion tiles (sale banners) have neither and are not products.
  const tiles = all.filter(t => t.querySelector('[data-itemid]'));
  for (const t of tiles) {
    const id = t.querySelector('[data-itemid]').getAttribute('data-itemid') ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) fail('TILE_IDENTITY');
    const link = [...t.querySelectorAll('a[href]')].map(a => { try { return new URL(a.getAttribute('href'), 'https://www.gnc.com'); } catch { return null; } })
      .find(u => u && u.hostname === 'www.gnc.com' && u.pathname.endsWith(`/${id}.html`) && !/demandware\.store/.test(u.pathname));
    if (!link) fail('TILE_IDENTITY');
    if (!items.has(id)) { items.set(id, `https://www.gnc.com${link.pathname}`); kinds.set(id, /^\d{6}$/.test(id) ? 'sku' : 'family'); organic.push(id); }
  }
  const promotions = all.length - tiles.length;
  // The visible "N Results" is the brand total. data-actual-productcount is only this page's count (GNC house brand
  // 2026-09-28: "585 Results" with data-actual-productcount="200.0"), so it is a fallback when the text is missing.
  const totalText = text(d.getElementById('results-products')).match(/(\d[\d,]*)\s+Results\b/)?.[1]
    ?? text(d.body).match(/\bof\s+(\d[\d,]*)\s+Results\b/)?.[1];
  const countInput = d.querySelector('.product-custom-count[data-actual-productcount]');
  const total = totalText ? Number(totalText.replaceAll(',', '')) : countInput ? Number(countInput.getAttribute('data-actual-productcount')) : null;
  if (tiles.length && total === null) fail('COUNT_MISSING');
  let nextPage = null;
  const more = d.querySelector('.load-more-products[data-grid-url], [data-grid-url].load-more') ?? d.querySelector('a[rel="next"][href]');
  const nextRaw = more?.getAttribute('data-grid-url') ?? more?.getAttribute('href');
  if (nextRaw) {
    const start = Number(new URL(nextRaw, 'https://www.gnc.com').searchParams.get('start'));
    if (start !== address.page * GNC_PAGE_SIZE) fail('PAGINATION');
    nextPage = address.page + 1;
  }
  // The load-more button can come without a link; a stated total beyond this page means there is a next page.
  if (nextPage === null && tiles.length && total !== null && total > address.page * GNC_PAGE_SIZE) nextPage = address.page + 1;
  return { url: address.url, page: address.page, organic, items: Object.fromEntries(items), kinds: Object.fromEntries(kinds), promotions, sponsored: 0, cards: tiles.length, nextPage,
    brandFilterSelected: null, totalResults: Number.isFinite(total) ? total : null, totalIsLowerBound: false };
}
