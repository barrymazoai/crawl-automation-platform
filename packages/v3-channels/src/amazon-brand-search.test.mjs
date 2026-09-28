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
