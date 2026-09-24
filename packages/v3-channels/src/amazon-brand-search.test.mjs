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
