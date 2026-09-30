import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swansonScanAddress, swansonScanPageUrl, swansonScanPage, SWANSON_PAGE_SIZE } from './swanson-brand-scan.mjs';

const brand = 'https://www.swansonvitamins.com/collections/brand-healthy-origins';
const first = 'https://www.swansonvitamins.com/collections/brand-healthy-origins/products.json?limit=250&page=1';
const product = (id, handle, published = '2025-05-19T13:42:20-05:00') => ({ id, title: 'T', handle, vendor: 'Healthy Origins', published_at: published, created_at: published,
  variants: [{ id: id + 1, sku: 'HO' + id, available: true, price: '19.99', title: 'Default Title' }] });

test('swanson scan address: a brand collection becomes its products.json pages; other shapes rejected', () => {
  assert.deepEqual(swansonScanAddress(brand), { url: first, kind: 'swanson-brand', slug: 'healthy-origins', page: 1 });
  assert.equal(swansonScanAddress(brand + '?sortBy=new_date&sortOrder=descending&page=4').url, first);
  assert.equal(swansonScanPageUrl(brand, 3), first.replace('page=1', 'page=3'));
  assert.equal(swansonScanAddress(first.replace('page=1', 'page=2')).page, 2);
  for (const bad of ['https://www.swansonvitamins.com/collections/vitamins', first.replace('limit=250', 'limit=10'), 'https://evil.example/collections/brand-x', first.replace('page=1', 'page=0')])
    assert.throws(() => swansonScanAddress(bad), /BRAND_SCAN.URL/);
});

test('swanson scan page: every product with variants and dates; a full page means more, a short page ends the list', () => {
  const p = swansonScanPage(JSON.stringify({ products: [product(8572271624330, 'healthy-origins-pycnogenol-100-mg-60-vcaps'), product(8572271624331, 'healthy-origins-k2-180')] }), first);
  assert.deepEqual(p.organic, ['8572271624330', '8572271624331']);
  assert.equal(p.items['8572271624330'].url, 'https://www.swansonvitamins.com/p/healthy-origins-pycnogenol-100-mg-60-vcaps');
  assert.deepEqual(p.items['8572271624330'].variants, [{ id: '8572271624331', sku: 'HO8572271624330', available: true, price: '19.99', title: 'Default Title' }]);
  assert.equal(p.nextPage, null); assert.equal(p.cards, 2);
  const full = swansonScanPage(JSON.stringify({ products: Array.from({ length: SWANSON_PAGE_SIZE }, (_, i) => product(1000000 + i, 'p-' + i)) }), first);
  assert.equal(full.nextPage, 2);
});

test('swanson scan page: a challenge page, non-JSON and broken products stop the brand', () => {
  assert.throws(() => swansonScanPage('<html><title>Just a moment...</title></html>', first), /ACCESS_CHALLENGE/);
  assert.throws(() => swansonScanPage('<html>oops</html>', first), /NOT_JSON/);
  assert.throws(() => swansonScanPage(JSON.stringify({ items: [] }), first), /NOT_JSON/);
  assert.throws(() => swansonScanPage(JSON.stringify({ products: [{ id: 'x', handle: 'a', variants: [] }] }), first), /TILE_IDENTITY/);
});
