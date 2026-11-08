import { brandScanErrors } from "@crawl-automation/channels-core";
import { describe, expect, it } from "vitest";
import { amazonBrandLookupUrl, amazonBrandSearchFromLookup } from "./brand-lookup.js";
import { AMAZON_IN } from "./site.js";

// KAN-243: markup copied from a real amazon.in search, "Redcon1" in Diet & Nutrition (2026-11-08); the page itself
// stays out of git.
const brand = (
  id: string,
  label: string,
) => `<li id="p_123/${id}" aria-labelledby="-title" class="a-spacing-micro">
  <span class="a-list-item"><a data-routing="" aria-label="Apply the filter ${label} to narrow results" class="a-link-normal s-navigation-item" href="/s?k=Redcon1&amp;rh=n%3A1374489031%2Cp_123%3A${id}">
  <div class="a-checkbox a-checkbox-fancy s-navigation-checkbox aok-float-left"><label><input type="checkbox" name="" value=""><i class="a-icon a-icon-checkbox"></i><span class="a-label a-checkbox-label"></span></label></div>
  <span class="a-size-base a-color-base">${label}</span></a></span></li>`;
const page = (...brands: string[]) => `<html><body><div id="refinements">
  <div id="brandsRefinements" aria-labelledby="p_123-title" class="a-section a-spacing-none" role="group">
  <div id="p_123-title"><span class="a-size-base a-color-base puis-bold-weight-text">Brands</span></div>
  <ul id="filter-p_123">${brands.join("")}</ul></div></div>
  <div class="s-main-slot"></div></body></html>`;
const REDCON1 = page(brand("585714", "Redcon1"), brand("256493", "Carbamide Forte"));

describe("amazon.in brand ID lookup (owner 2026-11-08)", () => {
  it("searches the brand name in the supplement department, best sellers first, marks dropped", () => {
    expect(amazonBrandLookupUrl("NOW®", AMAZON_IN)).toBe(
      "https://www.amazon.in/s?k=NOW&i=hpc&rh=n%3A1374489031&s=exact-aware-popularity-rank",
    );
    expect(() => amazonBrandLookupUrl("™", AMAZON_IN)).toThrow();
  });

  it("takes the one brand of the Brands filter named the same way as its scan source", () => {
    expect(amazonBrandSearchFromLookup(REDCON1, "REDCON1®", AMAZON_IN)).toBe(
      "https://www.amazon.in/s?k=REDCON1&i=hpc&rh=n%3A1374489031%2Cp_123%3A585714&s=exact-aware-popularity-rank",
    );
    expect(
      amazonBrandSearchFromLookup(
        page(brand("1", "Dr. Olivia Naturals")),
        "Dr Olivia Naturals",
        AMAZON_IN,
      ),
    ).toContain("p_123%3A1");
  });

  it("finds none when only a longer or shorter name, several brands, or no Brands filter are shown", () => {
    expect(amazonBrandSearchFromLookup(REDCON1, "Redcon", AMAZON_IN)).toBeNull();
    expect(amazonBrandSearchFromLookup(REDCON1, "Carbamide", AMAZON_IN)).toBeNull();
    const twice = page(brand("11", "Six Star"), brand("12", "SIX STAR"));
    expect(amazonBrandSearchFromLookup(twice, "Six Star", AMAZON_IN)).toBeNull();
    // Boiron, 2026-11-08: 28 results and no Brands filter at all.
    expect(amazonBrandSearchFromLookup(page(), "Boiron", AMAZON_IN)).toBeNull();
  });

  it("never reads a verification page or another answer as a brand that is not sold", () => {
    const challenge = "<html><body><h4>Enter the characters you see below</h4></body></html>";
    expect(() => amazonBrandSearchFromLookup(challenge, "Redcon1", AMAZON_IN)).toThrow(
      expect.objectContaining({ code: brandScanErrors.code("BRAND_SCAN.ACCESS_CHALLENGE") }),
    );
    expect(() => amazonBrandSearchFromLookup("<html></html>", "Redcon1", AMAZON_IN)).toThrow(
      expect.objectContaining({ code: brandScanErrors.code("BRAND_SCAN.NOT_HTML") }),
    );
  });
});
