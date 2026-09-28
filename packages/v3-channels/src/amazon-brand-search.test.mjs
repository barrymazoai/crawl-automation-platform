import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSearch, searchAddress, filterIdentity } from './amazon-brand-search.mjs';
const start='https://www.amazon.com/s?k=Herb+Pharm&i=hpc';
const url=start+'&rh=n%3A3760901%2Cp_123%3A383950&dc=';
const option=(checked,name,href,facet='p_123/383950')=>`<li id="${facet}"><a class="s-navigation-item" href="${href.replaceAll('&','&amp;')}" aria-label="${checked?'Remove':'Apply'} ${name} filter" aria-current="${checked}"><input type="checkbox" ${checked?'checked':''}>${name}</a></li>`;
const fixture=(checked=false,name='Herb Pharm',href=url,extra='')=>`<select name="url"><option selected value="search-alias=hpc">Health</option></select><ul id="filter-p_123">${option(checked,name,href)}</ul>${extra}<div class="s-main-slot"><div data-component-type="s-search-result" data-asin="B00014FRVW"><h2>Herb Pharm</h2></div></div>`;
test('a same-name Seller option is not a brand: no false ambiguity, no seller-only match',()=>{
 const seller=`<ul id="filter-p_6">${option(false,'Herb Pharm',start+'&rh=n%3A3760901%2Cp_6%3AA1XYZ&dc=','p_6/A1XYZ')}</ul>`;
 assert.equal(inspectSearch(fixture(false,'Herb Pharm',url,seller),start,['Herb Pharm']).url,url);
 const sellerOnly=fixture(false,'Other',url,seller);assert.throws(()=>inspectSearch(sellerOnly,start,['Herb Pharm']),/BRAND_FILTER_MISSING/);
});
test('an SEO-path brand link inside the Health node becomes the standard address; others stay rejected',()=>{
 const seo='/Herb-Pharm-Health-Household/s?k=Herb+Pharm&rh=n%3A3760901%2Cp_123%3A383950';
 assert.equal(inspectSearch(fixture(false,'Herb Pharm',seo),start,['Herb Pharm']).url,url);
 const outside='/Herb-Pharm-Beauty/s?k=Herb+Pharm&rh=n%3A11060451%2Cp_123%3A383950';
 assert.throws(()=>inspectSearch(fixture(false,'Herb Pharm',outside),start,['Herb Pharm']),/URL/);
});
test('a drifted dropdown label passes only when the left panel selects Health & Household',()=>{
 const drift=p=>p.replace('<option selected value="search-alias=hpc">Health</option>','<option selected value="srs=1&search-alias=specialty-aps">JAPAN STORE-Kitchen</option>');
 const panel=sel=>`<div id="departments"><ul><li><a href="/s">Any Department</a></li><li><span class="a-text-bold">${sel}</span></li></ul></div>`;
 const a=inspectSearch(fixture(),start,['Herb Pharm']);
 const ok=inspectSearch(drift(fixture(true))+panel('Health & Household'),url,['Herb Pharm'],a);
 assert.equal(ok.selected,true);assert.equal(ok.departmentState.panelSelected,'Health & Household');
 assert.throws(()=>inspectSearch(drift(fixture(true))+panel('Beauty & Personal Care'),url,['Herb Pharm'],a),/CATEGORY_LOST/);
 assert.throws(()=>inspectSearch(drift(fixture(true)),url,['Herb Pharm'],a),/CATEGORY_LOST/);
});
test('discover actual exact brand and verify applied filter',()=>{const a=inspectSearch(fixture(),start,['Herb Pharm']);assert.equal(a.url,url);const b=inspectSearch(fixture(true),url,['Herb Pharm'],a);assert.equal(b.selected,true);assert.equal(b.organicResultCards,1);});
test('reject lookalike names, missing selection and changed scope',()=>{const a=inspectSearch(fixture(),start,['Herb Pharm']);assert.throws(()=>inspectSearch(fixture(false,'Herb Pharma'),start,['Herb Pharm']),/MISSING/);assert.throws(()=>inspectSearch(fixture(),url,['Herb Pharm'],a),/FILTER_STATE/);assert.throws(()=>inspectSearch(fixture(true),url.replace('383950','1234'),['Herb Pharm'],a),/FILTER_STATE/);});
test('reject ambiguous exact facets and no organic results',()=>{assert.throws(()=>inspectSearch(fixture()+fixture(),start,['Herb Pharm']),/AMBIGUOUS/);const a=inspectSearch(fixture(),start,['Herb Pharm']);assert.throws(()=>inspectSearch(fixture(true).replace('<h2>','<a href="/sspa/click"></a><h2>'),url,['Herb Pharm'],a),/NO_MAIN_RESULTS/);});
test('reject foreign URLs, added filters, challenge and category loss',()=>{assert.throws(()=>searchAddress('https://evil.example/s?k=a&i=hpc'),/URL/);assert.throws(()=>filterIdentity(url+'&page=2'),/URL/);assert.throws(()=>filterIdentity(url.replace('383950','383950%2Cp_123%3A1234')),/SCOPE/);assert.throws(()=>inspectSearch('Robot Check',start,['Herb Pharm']),/CHALLENGE/);assert.throws(()=>inspectSearch(fixture().replace('search-alias=hpc','search-alias=aps'),start,['Herb Pharm']),/CATEGORY/);});
test('temporary parameters are removed; punctuation is not fuzzy matched',()=>{assert.equal(searchAddress(url+'&qid=1&ref=abc'),url);assert.throws(()=>inspectSearch(fixture(false,"Herb-Pharm"),start,['Herb Pharm']),/MISSING/);});
import { productAddress, productByline } from './amazon-brand-search.mjs';
const pdp=(asin,byline,href)=>`<div id="ppd"><input id="ASIN" value="${asin}"><span id="productTitle">Thing</span><a id="bylineInfo" href="${href}">${byline}</a></div>`;
test('product address accepts dp and slugged dp only',()=>{
 assert.equal(productAddress('https://www.amazon.com/Some-Slug/dp/B00014FRVW?th=1').url,'https://www.amazon.com/dp/B00014FRVW');
 assert.throws(()=>productAddress('https://www.amazon.com/s?k=x'),/URL/);assert.throws(()=>productAddress('https://evil.example/dp/B00014FRVW'),/URL/);
});
test('byline gives the Amazon brand name and a store link only when it is a store page',()=>{
 const a=productByline(pdp('B00014FRVW','Visit the Herb Pharm Store','/stores/HerbPharm/page/11111111-1111-4111-8111-111111111111?lp_asin=B00014FRVW'),'B00014FRVW');
 assert.equal(a.name,'Herb Pharm');assert.equal(a.storeUrl,'https://www.amazon.com/stores/HerbPharm/page/11111111-1111-4111-8111-111111111111');
 const b=productByline(pdp('B00014FRVW','Brand: Herb Pharm','/s/ref=bl_dp_s_web_0?field-keywords=Herb+Pharm'),'B00014FRVW');
 assert.equal(b.name,'Herb Pharm');assert.equal(b.storeUrl,null);
 assert.throws(()=>productByline(pdp('B00000XXXX','Brand: X','/s'),'B00014FRVW'),/PRODUCT_IDENTITY/);
 assert.throws(()=>productByline('<div id="ppd"><input id="ASIN" value="B00014FRVW"></div>','B00014FRVW'),/BYLINE_MISSING/);
});
import { organicAsins } from './amazon-brand-search.mjs';
test('organic result ASINs skip sponsored cards and keep page order',()=>{
 const card=(a,s='')=>`<div data-component-type="s-search-result" data-asin="${a}">${s}</div>`;
 const html=`<div class="s-main-slot">${card('B000000001','<span class="puis-sponsored-label-text">Sponsored</span>')}${card('B000000002')}${card('bad')}${card('B000000003')}</div>`;
 assert.deepEqual(organicAsins(html),['B000000002','B000000003']);assert.deepEqual(organicAsins(html,1),['B000000002']);
});
import { scanAddress, scanPageUrl, scanPage } from './amazon-brand-search.mjs';
import { readFileSync } from 'node:fs';
const stored = 'https://www.amazon.com/s?k=Herb+Pharm&i=hpc&rh=n%3A3760901%2Cp_123%3A383950&dc=';
const scan1 = 'https://www.amazon.com/s?k=Herb+Pharm&i=hpc&rh=n%3A3760901%2Cp_123%3A383950&s=date-desc-rank&dc=';
const scanPageHtml = ({ page = 1, asins = ['B00014FRVW'], sponsored = [], next = true, checked = true, facet = 'p_123/383950', total = '341', carousel = [] } = {}) =>
  `<ul><li id="${facet}"><a class="s-navigation-item"><input type="checkbox" ${checked ? 'checked' : ''}>Herb Pharm</a></li></ul>` +
  `<div data-component-type="s-result-info-bar">1-24 of ${total} results for "Herb Pharm"</div>` +
  `<div class="s-main-slot">${asins.map(a => `<div data-component-type="s-search-result" data-asin="${a}"><h2>x</h2></div>`).join('')}` +
  `${sponsored.map(a => `<div data-component-type="s-search-result" data-asin="${a}"><span class="puis-sponsored-label-text">Sponsored</span></div>`).join('')}</div>` +
  `<div class="carousel">${carousel.map(a => `<div data-asin="${a}"></div>`).join('')}</div>` +
  `<span class="s-pagination-item s-pagination-selected">${page}</span>` +
  (next ? `<a class="s-pagination-item s-pagination-next" href="/s?k=Herb+Pharm&amp;page=${page + 1}&amp;qid=1">Next</a>` : '<span class="s-pagination-next s-pagination-disabled">Next</span>');
test('scan address: stored brand URLs become newest-first pages; tracking removed; other sorts and shapes rejected', () => {
  assert.deepEqual(scanAddress(stored), { url: scan1, kind: 'brand-filter-search', page: 1, brandFilter: 'p_123:383950' });
  assert.equal(scanPageUrl(stored, 3), scan1.replace('&dc=', '&page=3&dc='));
  assert.equal(scanAddress(scan1.replace('&dc=', '&page=3&dc=&qid=9&xpid=abc&ref=sr_pg_2')).page, 3);
  assert.equal(scanPageUrl(scanPageUrl(stored, 3), 1), scan1);
  const brandPage = 'https://www.amazon.com/s?srs=119148022011&rh=p_89%3AFreak%2BShake';
  assert.equal(scanAddress(brandPage).url, brandPage + '&s=date-desc-rank');
  assert.equal(scanAddress(brandPage).kind, 'brand-page');
  assert.throws(() => scanAddress(stored.replace('i=hpc', 'i=aps')), /URL/);
  assert.throws(() => scanAddress(stored + '&s=price-asc-rank'), /URL/);
  assert.throws(() => scanAddress(stored + '&page=0'), /URL/);
  assert.throws(() => scanAddress(stored + '&page=51'), /URL/);
  assert.throws(() => scanAddress(stored.replace('383950', '383950%2Cp_123%3A1')), /SCOPE/);
  assert.throws(() => scanAddress('https://www.amazon.com/s?srs=1&rh=p_89%3AA%2Cp_123%3A2'), /URL/);
  assert.throws(() => scanAddress('https://evil.example/s?k=a&i=hpc'), /URL/);
});
test('scan page: organic main-slot ASINs only, next page, total, brand filter still applied', () => {
  const p = scanPage(scanPageHtml({ asins: ['B00014FRVW', 'B00014FRVW', 'B0000000A1'], sponsored: ['B0SPONSOR1'], carousel: ['B0CAROUSEL'] }), scan1);
  assert.deepEqual(p.organic, ['B00014FRVW', 'B0000000A1']);
  assert.equal(p.sponsored, 1); assert.equal(p.nextPage, 2); assert.equal(p.totalResults, 341); assert.equal(p.brandFilterSelected, true);
  const last = scanPage(scanPageHtml({ page: 2, next: false }), scanPageUrl(stored, 2));
  assert.equal(last.nextPage, null); assert.equal(last.page, 2);
  const empty = scanPage('<div class="s-main-slot"></div>', scanPageUrl(stored, 2));
  assert.deepEqual(empty.organic, []); assert.equal(empty.nextPage, null);
});
test('scan page: lost filter, wrong page, skipped page link and challenge stop the brand', () => {
  assert.throws(() => scanPage(scanPageHtml({ checked: false }), scan1), /FILTER_LOST/);
  assert.throws(() => scanPage(scanPageHtml({ facet: 'p_123/1' }), scan1), /FILTER_LOST/);
  assert.throws(() => scanPage(scanPageHtml({ page: 1 }), scanPageUrl(stored, 2)), /PAGE_MISMATCH/);
  assert.throws(() => scanPage(scanPageHtml().replace('page=2', 'page=4'), scan1), /PAGINATION/);
  assert.throws(() => scanPage('Robot Check', scan1), /CHALLENGE/);
});
test('scan page: the retained Herb Pharm ScraperAPI page (2026-09-23) parses as page 1 of a paged brand list', () => {
  const html = readFileSync(new URL('../../../docs/quality/evidence/2026-09-23-brand-scraperapi-check/02-filtered.original.html', import.meta.url), 'utf8');
  const p = scanPage(html, stored);
  assert.equal(p.organic.length + p.sponsored, 24); assert.ok(p.organic.length >= 20);
  assert.equal(p.nextPage, 2); assert.equal(p.totalResults, 341); assert.equal(p.brandFilterSelected, true);
});
