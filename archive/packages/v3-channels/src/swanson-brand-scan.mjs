// Swanson brand scan: every product of one Swanson brand collection through Shopify's own collection JSON
// (/collections/brand-<slug>/products.json). Checked through ScraperAPI on 2026-09-28 (1 credit, no challenge):
// Healthy Origins returned all 65 products (each size is its own product; the site grid groups them into 44 families)
// with ids, handles, publish dates and every variant's SKU and availability. Shopify pages hold at most 250 products;
// a page with fewer ends the list, so a scan can prove it read the whole collection. The site's "Newest" order is
// applied by script, so newest-first comes from published_at here.
export const SWANSON_PAGE_SIZE = 250;
const fail = code => { throw Error('BRAND_SCAN.' + code); };
export function swansonScanAddress(raw) {
  const u = new URL(raw, 'https://www.swansonvitamins.com');
  if (!['https://www.swansonvitamins.com', 'https://swansonvitamins.com'].includes(u.origin) || u.username || u.password) fail('URL');
  const slug = u.pathname.match(/^\/collections\/brand-([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/products\.json)?\/?$/)?.[1]; if (!slug) fail('URL');
  const limit = u.searchParams.get('limit'); if (limit !== null && limit !== String(SWANSON_PAGE_SIZE) && u.pathname.endsWith('.json')) fail('URL');
  const page = Number(u.pathname.endsWith('.json') ? (u.searchParams.get('page') ?? 1) : 1);
  if (!Number.isInteger(page) || page < 1 || page > 50) fail('URL');
  const r = new URL(`https://www.swansonvitamins.com/collections/brand-${slug}/products.json`);
  r.searchParams.set('limit', String(SWANSON_PAGE_SIZE)); r.searchParams.set('page', String(page));
  return { url: r.href, kind: 'swanson-brand', slug, page };
}
export const swansonScanPageUrl = (base, page) => { const u = new URL(swansonScanAddress(base).url); u.searchParams.set('page', String(page)); return swansonScanAddress(u.href).url; };
export function swansonScanPage(body, requestedUrl) {
  const address = swansonScanAddress(requestedUrl);
  let json; try { json = JSON.parse(body); } catch { fail(/cf-chl|Just a moment|Attention Required|captcha/i.test(body) ? 'ACCESS_CHALLENGE' : 'NOT_JSON'); }
  if (!json || !Array.isArray(json.products)) fail('NOT_JSON');
  if (json.products.length > SWANSON_PAGE_SIZE) fail('PAGINATION');
  const organic = [], items = {};
  for (const p of json.products) {
    const id = String(p?.id ?? ''), handle = String(p?.handle ?? '');
    if (!/^\d{6,20}$/.test(id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle) || !Array.isArray(p.variants)) fail('TILE_IDENTITY');
    if (items[id]) continue;
    organic.push(id);
    items[id] = { handle, url: `https://www.swansonvitamins.com/p/${handle}`, title: String(p.title ?? '').slice(0, 300), vendor: String(p.vendor ?? '').slice(0, 120),
      publishedAt: p.published_at ?? null, createdAt: p.created_at ?? null,
      variants: p.variants.map(v => ({ id: String(v.id), sku: v.sku ?? null, available: v.available ?? null, price: v.price ?? null, title: String(v.title ?? '').slice(0, 120) })) };
  }
  return { url: address.url, page: address.page, organic, items, sponsored: 0, cards: json.products.length,
    nextPage: json.products.length === SWANSON_PAGE_SIZE ? address.page + 1 : null, brandFilterSelected: null, totalResults: null, totalIsLowerBound: false };
}
