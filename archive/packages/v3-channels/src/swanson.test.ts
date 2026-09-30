import { describe, expect, it } from "vitest";
import { parseSwansonCatalog, parseSwansonFactsFragment, parseSwansonProduct } from "./swanson.js";
// Synthetic counterexamples, not claims about the current live Swanson template.
const origin = "https://www.swansonvitamins.com", url = `${origin}/products/vitamin-b12?variant=20`;
const p = { id: 10, handle: "vitamin-b12", title: "Vitamin B12", vendor: "Example", description: "<p>Product description</p>",
  variants: [{ id: 20, title: "60 capsules", options: ["60 capsules"], featured_image: { src: "https://cdn.shopify.com/selected.jpg" } }, { id: 21, title: "120 capsules" }],
  images: ["https://cdn.shopify.com/general.jpg", "https://cdn.shopify.com/selected.jpg"] };
const catalog = (results: unknown[]) => ({ response: { results, total_num_results: 1 } });
describe("Swanson saved-evidence candidate parser", () => {
  it("decodes escaped quotes, slashes and unicode in complete facts strings", () => {
    const html = '<p data-note="a\\b">B12 1,000 μg</p>', fragment = JSON.stringify({ supplementFacts: html, otherIngredients: "<p>Rice flour</p>" });
    expect(parseSwansonFactsFragment(fragment)).toEqual([{ field: "supplementFacts", html, scope: "product-unassigned-variant" },
      { field: "otherIngredients", html: "<p>Rice flour</p>", scope: "product-unassigned-variant" }]);
  });
  it("does not count empty or heading-only facts", () => {
    expect(parseSwansonFactsFragment(JSON.stringify({ supplementFacts: "<h2>Supplement Facts</h2>", ingredients: "  " }))).toEqual([]);
  });
  it.each([
    ['"supplementFacts":"<p>B12', "TRUNCATED_FACTS"], ['"ingredients":"bad\\q"', "INVALID_FACTS"],
    ['"ingredients":"<p>Rice</p>","ingredients":"<p>Soy</p>"', "AMBIGUOUS_FACTS"],
  ])("rejects incomplete or conflicting facts", (fragment, code) => { expect(() => parseSwansonFactsFragment(fragment)).toThrow(`SWANSON.${code}`); });
  it("deduplicates identical facts without selecting the first conflicting record", () => {
    expect(parseSwansonFactsFragment('"ingredients":"Rice","ingredients":"Rice"')).toHaveLength(1);
  });
  it("binds the selected variant but leaves multi-variant general gallery/facts unassigned", () => {
    const out = parseSwansonProduct(p, url, "20", JSON.stringify({ supplementFacts: "B12 1000 mcg" }));
    expect(out.listingId).toBe("10"); expect(out.variantId).toBe("20"); expect(out.variantOptions).toEqual(["60 capsules"]);
    expect(out.imageCandidates).toHaveLength(2); expect(out.imageCandidates[0]).toMatchObject({ variantId: "20", basis: "variant-featured", verifiedOriginal: false });
    expect(out.imageCandidates[1]?.variantId).toBeNull(); expect(out.factsCandidates[0]?.scope).toBe("product-unassigned-variant");
    expect(out.variants[1]?.url).toBe(`${origin}/products/vitamin-b12?variant=21`);
    expect(out.warnings).toContain("CHANNEL.PROFILE_LIVE_UNVERIFIED");
  });
  it("single-variant product gallery can be bound, without claiming verified original images", () => {
    const out = parseSwansonProduct({ ...p, variants: [p.variants[0]] }, url, "20");
    expect(out.imageCandidates.every(i => i.variantId === "20" && !i.verifiedOriginal)).toBe(true);
  });
  it.each([`${origin}/products/other?variant=20`, `${origin}/products/vitamin-b12?variant=21`, `${url}&variant=21`, `${url}&foo=bar`])("rejects URL/variant conflict: %s", bad => {
    expect(() => parseSwansonProduct(p, bad, "20")).toThrow("SWANSON.VARIANT_CONFLICT");
  });
  it("rejects duplicate variants, unknown selected variants and foreign image origins", () => {
    expect(() => parseSwansonProduct({ ...p, variants: [p.variants[0], p.variants[0]] }, url, "20")).toThrow("SWANSON.VARIANT_CONFLICT");
    expect(() => parseSwansonProduct(p, url.replace("20", "99"), "99")).toThrow("SWANSON.VARIANT_CONFLICT");
    expect(() => parseSwansonProduct({ ...p, images: ["https://evil.example/label.jpg"] }, url, "20")).toThrow("CHANNEL.IMAGE_URL_REJECTED");
  });
  it("expands variants incrementally without comparing them to parent count or claiming completion", () => {
    const out = parseSwansonCatalog(catalog([{ value: "B12", data: { url: "vitamin-b12", product_id: 10, variant_id: 20 },
      variations: [{ data: { url: "products/vitamin-b12", variant_id: 21 } }] }]), `${origin}/collections/example`, null);
    expect(out.entries).toHaveLength(2); expect(out.entries.map(e => e.listingId)).toEqual(["10", "10"]);
    expect(out.reportedTotal).toBe(1); expect(out.completion).toBe("unverified_end");
  });
  it("deduplicates repeated page entries and keeps a same-catalog next-page hint", () => {
    const r = { data: { url: "vitamin-b12", product_id: "10", variant_id: "20" } };
    const out = parseSwansonCatalog(catalog([r, r]), `${origin}/collections/example`, `${origin}/collections/example?page=2`);
    expect(out.entries).toHaveLength(1); expect(out.completion).toBe("more");
  });
  it("empty response is unverified end, not proof of brand/product absence", () => {
    expect(parseSwansonCatalog(catalog([]), `${origin}/collections/example`, null).completion).toBe("unverified_end");
  });
  it.each([
    [{ data: { url: "vitamin-b12" } }],
    [{ data: { url: "vitamin-b12?variant=99", product_id: 10, variant_id: 20 } }],
    [{ data: { url: "vitamin-b12", product_id: 10, variant_id: 20 } }, { data: { url: "other", product_id: 10, variant_id: 20 } }],
    [{ data: { url: "vitamin-b12", product_id: 10, variant_id: 20 }, variations: [{ data: { url: "vitamin-b12", product_id: 11, variant_id: 21 } }] }],
  ])("rejects unverified or conflicting catalog identity", (...rows) => { expect(() => parseSwansonCatalog(catalog(rows), `${origin}/collections/example`, null)).toThrow(); });
  it.each([`${origin}/collections/example`, `${origin}/collections/other?page=2`, "https://evil.example/page2"])("rejects looping or cross-catalog pagination", next => {
    expect(() => parseSwansonCatalog(catalog([]), `${origin}/collections/example`, next)).toThrow();
  });
  it("bounds source size before parsing", () => { expect(() => parseSwansonFactsFragment("x".repeat(4 * 1024 * 1024 + 1))).toThrow("SWANSON.PAGE_LIMIT"); });
});
