import { describe, expect, it } from "vitest";
import {
  companySearchQueries,
  exactIdentityVerdict,
  normalizeCompanyBrand,
  parseGncSearchHtml,
} from "./company-identity.js";

const searchHtml = `
<script>var dwData = [{"ecommerce":{"searchTerm":"Nordic Naturals","resultsNumber":1}}];</script>
<ul id="search-result-items"><li><div class="product-tile" data-gtmdata="{&quot;item_id&quot;:&quot;877172&quot;,&quot;item_name&quot;:&quot;Ultimate Omega&reg; Soft Gels&quot;,&quot;item_url&quot;:&quot;https://www.gnc.com/fish-oil-omegas/877172.html&quot;,&quot;item_brand&quot;:&quot;Nordic Naturals&reg;&quot;}"></div></li></ul>
<div class="related-links-container"><a href="https://www.gnc.com/brands/nordic-naturals/?x=1">Nordic Naturals&reg;</a></div>`;

describe("GNC company identity discovery", () => {
  it("parses structured product brands and official brand pages from search HTML", () => {
    const result = parseGncSearchHtml(searchHtml, "Nordic Naturals", "https://www.gnc.com/search?q=Nordic%20Naturals");
    expect(result).toMatchObject({ denied: false, explicitNoResults: false, returnedQuery: "Nordic Naturals", resultsNumber: 1 });
    expect(result.products).toEqual([{ sku: "877172", brand: "Nordic Naturals®", title: "Ultimate Omega® Soft Gels", url: "https://www.gnc.com/fish-oil-omegas/877172.html" }]);
    expect(result.brandPageUrls).toEqual(["https://www.gnc.com/brands/nordic-naturals/"]);
  });

  it("normalizes only harmless legal and trademark differences", () => {
    expect(normalizeCompanyBrand("Nordic Naturals, Inc.®")).toBe("nordicnaturals");
    expect(normalizeCompanyBrand("Garden of Life")).not.toBe(normalizeCompanyBrand("Nestlé Health Science"));
  });

  it("builds unique company, canonical, and website queries", () => {
    expect(companySearchQueries({ companyId: "1", companyName: "Example, Inc.", canonicalName: "Example", website: "https://example.com" })).toEqual(["Example, Inc."]);
  });

  it("auto-confirms only an exact structured brand identity", () => {
    const evidence = parseGncSearchHtml(searchHtml, "Nordic Naturals", "https://www.gnc.com/search?q=Nordic%20Naturals");
    const verdict = exactIdentityVerdict({ companyId: "1", companyName: "Nordic Naturals, Inc.", canonicalName: "Nordic Naturals", website: "https://nordic.com" }, [evidence]);
    expect(verdict).toMatchObject({ status: "confirmed", relationship: "exact_brand", gncBrandName: "Nordic Naturals®", confidence: 1 });
    expect(exactIdentityVerdict({ companyId: "2", companyName: "Nestlé Health Science", canonicalName: null, website: null }, [evidence])).toBeNull();
  });

  it("recognizes a PerimeterX challenge", () => {
    expect(parseGncSearchHtml("<div>Access to this page has been denied</div><script>_pxCaptcha</script>", "x", "https://www.gnc.com/search?q=x").denied).toBe(true);
  });

  it("does not treat no-result recommendation carousels as search matches", () => {
    const html = `<script>var dwData=[{"ecommerce":{"resultsNumber":0}}]</script>
      <div class="no-search-result-breadcrumb">No Results</div>
      <div id="no-search-results-carousel"><div data-gtmdata="{&quot;item_id&quot;:&quot;123456&quot;,&quot;item_name&quot;:&quot;Recommended&quot;,&quot;item_url&quot;:&quot;https://www.gnc.com/example/123456.html&quot;,&quot;item_brand&quot;:&quot;Other Brand&quot;}"></div></div>`;
    const result = parseGncSearchHtml(html, "missing", "https://www.gnc.com/search?q=missing");
    expect(result).toMatchObject({ resultsNumber: 0, explicitNoResults: true, products: [], brandPageUrls: [] });
  });
});
