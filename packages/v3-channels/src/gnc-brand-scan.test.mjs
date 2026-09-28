import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gncScanAddress, gncScanPageUrl, gncScanPage } from './gnc-brand-scan.mjs';

const base = 'https://www.gnc.com/brands/optimum-nutrition/';
const first = 'https://www.gnc.com/brands/optimum-nutrition/?srule=new-arrivals&start=0&sz=200';
const tile = (sku, slug = 'protein') => `<li class="grid-tile col-md-4"><div class="product-tile" data-itemid="${sku}"><a class="name-link" href="https://www.gnc.com/${slug}/${sku}.html">P</a></div><script>var s="RateLimiter-HideCaptcha"</script></li>`;
const page = ({ skus = ['352114', '352115'], total = skus.length, next = null } = {}) =>
  `<html><body><div>${total} Results</div><input class="product-custom-count" data-actual-productcount="${total}.0" value="0.0"/>` +
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
  assert.throws(() => gncScanPage(page().replace('data-itemid="352114"', 'data-itemid="x"').replace('/352114.html', '/x.html'), first), /TILE_IDENTITY/);
  assert.throws(() => gncScanPage(page({ next: 400 }), first), /PAGINATION/);
  assert.throws(() => gncScanPage(page().replace(/<div>\d+ Results<\/div><input[^>]+>/, ''), first), /COUNT_MISSING/);
  const empty = gncScanPage('<html><body><ul class="search-result-items"></ul><div>0 Results</div></body></html>', first);
  assert.deepEqual(empty.organic, []); assert.equal(empty.totalResults, 0);
});
