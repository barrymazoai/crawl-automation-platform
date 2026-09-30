import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeAddress, storePage, sameStore } from './amazon-store-scan.mjs';

const home = 'https://www.amazon.com/stores/HollyHillHealthFoods/page/6B01F4DD-3139-41B4-AA9F-E822D61DF144';
const tile = (asin, sponsored = false) => `<li><div data-asin="${asin}"><a href="/Some-Product/dp/${asin}?ref=x">P</a>${sponsored ? '<span>Sponsored</span>' : ''}</div></li>`;
const page = (body, title = 'Amazon.com: Holly Hill Health Foods') => `<html><head><title>${title}</title><script>var x="B0SCRIPT01"</script></head><body>${body}</body></html>`;

test('store address: key and keyless pages, tracking removed, other shapes rejected', () => {
  assert.deepEqual(storeAddress(home.toLowerCase().replace('hollyhillhealthfoods', 'HollyHillHealthFoods') + '?ingress=2&lp_asin=B0747WVD33#x'),
    { url: home, key: 'HollyHillHealthFoods', pageId: '6B01F4DD-3139-41B4-AA9F-E822D61DF144' });
  assert.equal(storeAddress('https://www.amazon.com/stores/page/D15D54FD-000A-45BB-A017-ECC0642B1014').key, null);
  assert.equal(storeAddress('https://www.amazon.com/stores/Nature%27s+Wellness/page/F8825552-94E0-484F-9824-F48358DDA663').key, "Nature's+Wellness");
  for (const bad of ['https://evil.example/stores/X/page/6B01F4DD-3139-41B4-AA9F-E822D61DF144', 'https://www.amazon.com/dp/B0747WVD33',
    'https://www.amazon.com/stores/X/page/not-a-uuid', 'https://www.amazon.com/stores/X/Y/page/6B01F4DD-3139-41B4-AA9F-E822D61DF144'])
    assert.throws(() => storeAddress(bad), /STORE_SCAN.URL/);
});

test('store page: products (sponsored and script text excluded), same-store links only, srs shortcut and Shop All noticed', () => {
  const html = page(`<nav><a href="/stores/HollyHillHealthFoods/page/11111111-1111-4111-8111-111111111111?ref_=nav">Vitamins</a>
    <a href="/stores/page/22222222-2222-4222-8222-222222222222">Shop All</a>
    <a href="/stores/OtherBrand/page/33333333-3333-4333-8333-333333333333">Other brand</a>
    <a href="${home}">Home (this page)</a><a href="/s?srs=123456789&rh=p_89:X">See more</a></nav>
    <ul>${tile('B0747WVD33')}${tile('B0747WVY85')}${tile('B0SPONSOR1', true)}</ul><a href="/dp/B0747WVD33">again</a>`);
  const p = storePage(html, home, 'HollyHillHealthFoods');
  assert.deepEqual(p.organic, ['B0747WVD33', 'B0747WVY85']);
  assert.deepEqual(p.sponsored, ['B0SPONSOR1']);
  assert.deepEqual(p.links.map(l => l.url), ['https://www.amazon.com/stores/HollyHillHealthFoods/page/11111111-1111-4111-8111-111111111111',
    'https://www.amazon.com/stores/page/22222222-2222-4222-8222-222222222222']);
  assert.equal(p.shopAll, true);
  assert.deepEqual(p.srsLinks, [{ url: 'https://www.amazon.com/s?srs=123456789', text: 'See more' }]);
  assert.equal(p.title, 'Amazon.com: Holly Hill Health Foods');
});

test('store page: challenge stops; store key comparison ignores case', () => {
  assert.throws(() => storePage('Enter the characters you see below', home, 'HollyHillHealthFoods'), /ACCESS_CHALLENGE/);
  assert.equal(sameStore(storeAddress('https://www.amazon.com/stores/hollyhillhealthfoods/page/11111111-1111-4111-8111-111111111111'), 'HollyHillHealthFoods'), true);
  assert.equal(sameStore(storeAddress('https://www.amazon.com/stores/Other/page/11111111-1111-4111-8111-111111111111'), 'HollyHillHealthFoods'), false);
});
