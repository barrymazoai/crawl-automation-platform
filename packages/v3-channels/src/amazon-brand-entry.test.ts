import { describe, it, expect } from 'vitest';
import { amazonEntryUrl, storeEntryUrl, seedBrand, directoryLinks } from './amazon-brand-entry.js';

const asin = 'B0016BGCRC', store = 'https://www.amazon.com/stores/HerbPharm/page/11111111-1111-4111-8111-111111111111';
const all = 'https://www.amazon.com/stores/HerbPharm/page/22222222-2222-4222-8222-222222222222';
const html = (href = store, brand = 'Visit the Herb Pharm Store') => `<html><link rel="canonical" href="https://www.amazon.com/dp/${asin}"><div id="ppd"><input id="ASIN" value="${asin}"><a id="bylineInfo" href="${href}">${brand}</a></div></html>`;
describe('Brand seed and directory identity', () => {
  it('extracts a real byline without requiring gallery/OCR data', () => expect(seedBrand(html(), asin, `https://www.amazon.com/dp/${asin}`)).toEqual({ name: 'Herb Pharm', brandRaw: 'Visit the Herb Pharm Store', storeUrl: store }));
  it('preserves a BOM in retained bytes while parsing a separate decoded view', () => expect(seedBrand('\ufeff' + html(), asin, `https://www.amazon.com/dp/${asin}`).name).toBe('Herb Pharm'));
  it.each(['https://amazon.com.evil.test/stores/x', 'https://user:secret@www.amazon.com/stores/x', 'http://www.amazon.com/stores/x', 'https://www.amazon.com:444/stores/x'])('rejects a foreign or unsafe address %s', url => expect(() => amazonEntryUrl(url)).toThrow('BRAND_ENTRY.URL'));
  it('does not turn a seller or search URL into a Store', () => expect(() => seedBrand(html('/s?rh=p_4%3AHerbPharm'), asin, `https://www.amazon.com/dp/${asin}`)).toThrow('STORE_LINK_UNVERIFIED'));
  it('rejects a different actual ASIN even when requested URL looks correct', () => expect(() => seedBrand(html().replace(`value="${asin}"`, 'value="B000000001"'), asin, `https://www.amazon.com/dp/${asin}`)).toThrow('PRODUCT_IDENTITY'));
  it('accepts the observed clp canonical form only when its ASIN agrees with the product inputs', () => {
    expect(seedBrand(html().replace(`/dp/${asin}`, `/clp/${asin}`), asin, `https://www.amazon.com/dp/${asin}`).name).toBe('Herb Pharm');
    expect(() => seedBrand(html().replace(`/dp/${asin}`, '/clp/B000000001'), asin, `https://www.amazon.com/dp/${asin}`)).toThrow('PRODUCT_IDENTITY');
  });
  it('rejects missing byline and challenge responses', () => {
    expect(() => seedBrand(html().replace('id="bylineInfo"', ''), asin, `https://www.amazon.com/dp/${asin}`)).toThrow('BRAND_LINK_MISSING');
    expect(() => seedBrand('Robot Check', asin, `https://www.amazon.com/dp/${asin}`)).toThrow('ACCESS_CHALLENGE');
  });
  it('does not truncate an unverified long brand name', () => expect(() => seedBrand(html(store, 'X'.repeat(81)), asin, `https://www.amazon.com/dp/${asin}`)).toThrow('BRAND_NAME_UNVERIFIED'));
  it('removes only known tracking parameters and keeps directory filters', () => expect(storeEntryUrl(store + '?ref_=abc&rh=p_4%3AHerb')).toBe(store + '?rh=p_4%3AHerb'));
  it('prefers explicit All Products over category navigation', () => expect(directoryLinks([{ text: 'Shop All', href: all, navigation: true }, { text: 'Home', href: store, navigation: true }], store)).toEqual({ kind: 'all_products', links: [{ text: 'Shop All', href: all, navigation: true }] }));
  it('does not call the home page a full catalog', () => expect(() => directoryLinks([{ text: 'Home', href: store, navigation: true }], store)).toThrow('DIRECTORY_MISSING'));
  it('preserves multiple category entries without claiming enumeration complete', () => {
    const result = directoryLinks([{ text: 'Herbs', href: all, navigation: true }, { text: 'About Us', href: store, navigation: true }], store);
    expect(result.kind).toBe('category_set'); expect(result.links).toHaveLength(1);
  });
  it('fails ambiguous All Products links instead of choosing one arbitrarily', () => expect(() => directoryLinks([{ text: 'Shop All', href: all, navigation: true }, { text: 'All Products', href: store, navigation: true }], store)).toThrow('ALL_PRODUCTS_AMBIGUOUS'));
});
