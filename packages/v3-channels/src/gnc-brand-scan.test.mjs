import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gncScanAddress, gncScanPageUrl, gncScanPage } from './gnc-brand-scan.mjs';

const base = 'https://www.gnc.com/brands/optimum-nutrition/';
const first = 'https://www.gnc.com/brands/optimum-nutrition/?srule=new-arrivals&start=0&sz=200';
const tile = (sku, slug = 'protein') => `<li class="grid-tile col-md-4"><div class="product-tile" data-itemid="${sku}"><a class="name-link" href="https://www.gnc.com/${slug}/${sku}.html">P</a></div><script>var s="RateLimiter-HideCaptcha"</script></li>`;
const page = ({ skus = ['352114', '352115'], total = skus.length, next = null } = {}) =>
  `<html><body><p class="content-header" id="results-products">(${total} Results)</p><input class="product-custom-count" data-actual-productcount="${total}.0" value="0.0"/>` +
  `<ul id="search-result-items" class="search-result-items tiles-container">${skus.map(s => tile(s)).join('')}</ul>` +
  (next !== null ? `<div class="load-more-products category-products" data-grid-url="${base}?srule=new-arrivals&amp;start=${next}&amp;sz=200&amp;format=page-element"></div>` : '') +
  `<div class="recommendations">${tile('999999')}</div></body></html>`;

test('gnc scan address: brand pages become newest-first 200-item pages; other shapes rejected', () => {
  assert.deepEqual(gncScanAddress(base), { url: first, kind: 'gnc-brand', slug: 'optimum-nutrition', page: 1 });
  assert.equal(gncScanAddress('https://gnc.com/brands/optimum-nutrition').url, first);
  assert.equal(gncScanPageUrl(base, 3), first.replace('start=0', 'start=400'));
  assert.equal(gncScanAddress(first.replace('start=0', 'start=200')).page, 2);
  for (const bad of [base + '?srule=price-low-to-high', first.replace('start=0', 'start=150'), 'https://www.gnc.com/protein/', 'https://evil.example/brands/x/', 'https://www.gnc.com/brands/Bad_Slug/'])
    assert.throws(() => gncScanAddress(bad), /BRAND_SCAN.URL/);
});

test('gnc scan page: grid tiles only, repeats merged, total from the page, next page from load-more', () => {
  const p = gncScanPage(page({ skus: ['352114', '352115', '352114'], total: 3, next: 200 }), first);
  assert.deepEqual(p.organic, ['352114', '352115']);
  assert.equal(p.cards, 3); assert.equal(p.totalResults, 3); assert.equal(p.nextPage, 2);
  assert.equal(p.items['352114'], 'https://www.gnc.com/protein/352114.html');
  assert.equal(gncScanPage(page(), first).nextPage, null);
});

test('gnc scan page: a real challenge stops; the RateLimiter config URL does not; broken tiles and skipped pages stop', () => {
  assert.doesNotThrow(() => gncScanPage(page(), first));
  assert.throws(() => gncScanPage('<html><body><div id="px-captcha"></div>Please verify you are a human</body></html>', first), /ACCESS_CHALLENGE/);
  assert.throws(() => gncScanPage(page().replace('data-itemid="352114"', 'data-itemid="bad id"'), first), /TILE_IDENTITY/);
  assert.throws(() => gncScanPage(page().replace('/352114.html', '/999999.html'), first), /TILE_IDENTITY/);
  assert.throws(() => gncScanPage(page({ next: 400 }), first), /PAGINATION/);
  assert.throws(() => gncScanPage(page().replace(/<p[^>]*>\(\d+ Results\)<\/p><input[^>]+>/, ''), first), /COUNT_MISSING/);
  const empty = gncScanPage('<html><body><p id="results-products">(0 Results)</p><ul class="search-result-items"></ul></body></html>', first);
  assert.deepEqual(empty.organic, []); assert.equal(empty.totalResults, 0);
});

test('gnc scan page: family products are kept as families; promotion tiles are not products', () => {
  const family = '<li class="grid-tile col-md-4"><div class="product-tile" data-itemid="GNCTotalLeanLeanShake12Pack"><a href="https://www.gnc.com/on/demandware.store/Sites-GNC2-Site/default/Wishlist-Add?pid=GNCTotalLeanLeanShake12Pack">W</a><a href="https://www.gnc.com/ready-to-drink-protein/GNCTotalLeanLeanShake12Pack.html">Lean Shake</a> View Options</div></li>';
  const promo = '<li class="grid-tile col-sm-6 col-md-4"><a href="https://www.gnc.com/sale/gnc-60-off-sale/">UP TO 60% OFF! SHOP NOW</a></li>';
  const html = page({ total: 3 }).replace('<ul id="search-result-items" class="search-result-items tiles-container">', `<ul id="search-result-items" class="search-result-items tiles-container">${promo}${family}`);
  const p = gncScanPage(html, first);
  assert.deepEqual(p.organic, ['GNCTotalLeanLeanShake12Pack', '352114', '352115']);
  assert.equal(p.kinds.GNCTotalLeanLeanShake12Pack, 'family'); assert.equal(p.kinds['352114'], 'sku');
  assert.equal(p.items.GNCTotalLeanLeanShake12Pack, 'https://www.gnc.com/ready-to-drink-protein/GNCTotalLeanLeanShake12Pack.html');
  assert.equal(p.cards, 3); assert.equal(p.promotions, 1); assert.equal(p.totalResults, 3);
});

test('gnc scan page: the visible "N Results" is the brand total, not the per-page count; a total beyond the page means a next page', () => {
  // GNC house brand 2026-09-28: 200 tiles on page 1, "585 Results", data-actual-productcount="200.0", load-more without a link.
  const html = page({ skus: ['352114', '352115'], total: 2 }).replace('(2 Results)', '(585 Results)')
    .replace('</ul>', '</ul><div class="load-more-products category-products"></div>');
  const p = gncScanPage(html, first);
  assert.equal(p.totalResults, 585); assert.equal(p.nextPage, 2);
  const last = gncScanPage(html, gncScanPageUrl(base, 3));
  assert.equal(last.nextPage, null);
});
