import { expect,it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSwansonRenderedCatalog } from "./swanson-catalog-rendered.js";
const url="https://www.swansonvitamins.com/collections/brand-ac-grace-company";
const sample=()=>({url:`${url}?view=sl-95018177#slr-grxmj75nnb00`,title:"A.C. Grace Company",capturedAt:"2026-09-10T02:25:27.797Z",headingContext:"A.C. Grace Company\n2 results",
  results:{tag:"UL",text:"Two synthetic products",links:[{text:"",url:`${url}/p/product-one`,ariaLabel:"Product One - View Product"},{text:"",url:`${url}/p/product-two`,ariaLabel:"Product Two - View Product"}],
    children:[{tag:"LI",class:"product-grid__item",id:"",role:null},{tag:"LI",class:"product-grid__item",id:"",role:null}]},visibleControls:[] as {tag:string;text:string;ariaLabel:null;disabled:boolean}[]});
it("observed view route and count prove the displayed listing, never variant completeness",()=>{
  const r=parseSwansonRenderedCatalog(sample(),url,"A.C. Grace Company");expect(r.completion).toBe("displayed_listing_complete");expect(r.entries).toHaveLength(2);
  expect(r.entries[0]).toMatchObject({handle:"product-one",title:"Product One"});expect(r.variantCoverage).toBe("unverified");
});
it.each([undefined,"3 results","Unknown"])("absent or mismatched count remains incomplete: %s",count=>{
  const p=sample();p.headingContext=count as any;expect(parseSwansonRenderedCatalog(p,url,p.title).completion).toBe("unverified_end");
});
it("active next page prevents false completion",()=>{const p=sample();p.visibleControls.push({tag:"BUTTON",text:"Next",ariaLabel:null,disabled:false});expect(parseSwansonRenderedCatalog(p,url,p.title).completion).toBe("unverified_end");});
it("an explicit same-brand next link advances exactly one page, without claiming SKU completeness",()=>{
  const p={...sample(),nextLinks:[url+"?page=2"]};
  expect(parseSwansonRenderedCatalog(p,url,p.title)).toMatchObject({nextUrl:url+"?page=2",completion:"unverified_end",variantCoverage:"unverified"});
});
it.each([url+"?page=1",url+"?page=3",url+"?page=2&filter=x",url.replace('ac-grace-company','other')+"?page=2"])("rejects foreign, filtered or skipped continuation %s",next=>{
 const p={...sample(),nextLinks:[next]};expect(()=>parseSwansonRenderedCatalog(p,url,p.title)).toThrow();
});
it.each(["?filter=vitamin","?view=unknown","?view=sl-1&view=sl-2","#other"])("rejects unverified route %s",suffix=>{const p=sample();p.url=url+suffix;expect(()=>parseSwansonRenderedCatalog(p,url,p.title)).toThrow();});
it("rejects another brand or injected product URL",()=>{const p=sample();p.results.links[0]!.url="https://evil.example/p/product-one";expect(()=>parseSwansonRenderedCatalog(p,url,p.title)).toThrow();});
it("missing hydrated list is not an empty successful catalog",()=>{const p=sample();expect(()=>parseSwansonRenderedCatalog({...p,results:null},url,p.title)).toThrow("SWANSON.CATALOG_NOT_READY");});
it("duplicate URLs do not manufacture a two-product closure",()=>{const p=sample();p.results.links[1]=p.results.links[0]!;expect(parseSwansonRenderedCatalog(p,url,p.title).completion).toBe("unverified_end");});
it("sold-out 'See other options' navigation is deduplicated without replacing the product title",()=>{
 const p=sample();p.results.links.push({...p.results.links[0]!,text:"See other options",ariaLabel:null as any});
 expect(parseSwansonRenderedCatalog(p,url,p.title).entries).toHaveLength(2);expect(parseSwansonRenderedCatalog(p,url,p.title).entries[0]!.title).toBe("Product One");
 p.results.links.reverse();expect(parseSwansonRenderedCatalog(p,url,p.title).entries.find(x=>x.handle==="product-one")!.title).toBe("Product One");
});
it("a real aria-labelled next page is a continuation, but a disabled next link is not",()=>{
 const p=sample();p.visibleControls.push({tag:"A",text:"",ariaLabel:"Go to next page" as any,disabled:false});
 expect(parseSwansonRenderedCatalog(p,url,p.title).completion).toBe("unverified_end");p.visibleControls[0]!.disabled=true;
 expect(parseSwansonRenderedCatalog(p,url,p.title).completion).toBe("displayed_listing_complete");
});
it("real Mini public catalog matches both independently captured product URLs",()=>{
  const root=process.env.V3_CHANNEL_FIXTURE_ROOT;if(!root)throw Error("Fixture root required");
  const p=JSON.parse(readFileSync(join(root,"swanson-catalog-public.json"),"utf8")),r=parseSwansonRenderedCatalog(p,url,"A.C. Grace Company");
  const expected=["swanson-product-public.json","swanson-second-public.json"].map(name=>JSON.parse(readFileSync(join(root,name),"utf8")).url);
  expect(r.entries.map(e=>e.url).sort()).toEqual(expected.sort());expect(r.reportedTotal).toBe(2);expect(r.completion).toBe("displayed_listing_complete");
});
