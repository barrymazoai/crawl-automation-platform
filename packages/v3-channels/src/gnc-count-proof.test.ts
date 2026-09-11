import { expect, it } from "vitest";
import { parseGncCatalog } from "./gnc.js";
const url="https://www.gnc.com/brands/focus-fuel/";
const html='<ul class="search-result-bookmarks" data-gtmsearchcount="1.0"><li>Products (1)</li></ul><ul id="search-result-items"><li class="product-tile" data-itemid="613701"><a href="/energy/613701.html">Product</a></li></ul><input class="product-custom-count" data-actual-productcount="1.0">';
it("matching independent counters and exact SKU cards prove one page only",()=>{expect(parseGncCatalog(html,url).countProof).toEqual({codec:"gnc-single-page-count/1",count:1});});
it.each(["count","visual-count","missing-counter","foreign-tile","next","filtered","duplicate"])("%s cannot imply complete catalog",mode=>{
  let body=html,source=url;
  if(mode==="count")body=body.replace('data-actual-productcount="1.0"','data-actual-productcount="2.0"');
  if(mode==="visual-count")body=body.replace("Products (1)","Products (2)");
  if(mode==="missing-counter")body=body.replace("product-custom-count","unknown");
  if(mode==="foreign-tile")body=body.replace("search-result-items","recommendations");
  if(mode==="next")body+='<a rel="next" href="?start=1">Next</a>';
  if(mode==="filtered")source+="?prefn1=flavor";
  if(mode==="duplicate")body+=html;
  expect(parseGncCatalog(body,source).countProof).toBeUndefined();
});
