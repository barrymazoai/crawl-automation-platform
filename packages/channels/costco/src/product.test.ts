import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { costcoAdapter } from "./adapter.js";
import { COSTCO_STORE, verifyCostcoStore } from "./store.js";

const html = readFileSync(new URL("./fixtures/product.html", import.meta.url), "utf8");
const page = {
  html,
  url: "https://www.costco.com/test-coq10.product.100029983.html",
  capturedAt: "2026-10-01T00:00:00Z",
};
const adapter = costcoAdapter();

it("reads own formula evidence, prices with labels, item number and warehouse metrics", () => {
  const parsed = adapter.parseProduct(page);
  expect(parsed.identity).toEqual({ listingId: "100029983", variantId: null });
  expect(parsed.evidence).toMatchObject({
    channel: "costco",
    title: "Test CoQ10 300 mg",
    brandRaw: "Example Brand",
  });
  expect(parsed.rendered).toMatchObject({
    itemNumber: "648220",
    warehouseId: "669",
    warehouseVerified: true,
  });
  expect(parsed.commerce).toMatchObject({
    price: "26.99",
    rating: "4.78",
    reviewCount: "8229",
    availability: null,
    context: expect.arrayContaining([
      "costco-store:669",
      "costco-item:648220",
      "costco-price:Member Price:24.99",
    ]),
  });
  expect(parsed.evidence.imageCandidates.map((image) => image.url)).toEqual([
    "https://gdx-assets.costco.com/front.avif",
    "https://gdx-assets.costco.com/label.avif",
  ]);
  expect(parsed.facts.complete).toBe(true);
  expect(parsed.facts.text).toContain("Coenzyme Q10 300 mg");
  expect(adapter.formulaFamily).toBeUndefined();
  const planning = adapter.planning;
  if (!planning) {
    throw new Error("Planning missing");
  }
  expect(planning.read(planning.projection(parsed.rendered), page.url, parsed.identity)).toEqual({
    evidence: parsed.evidence,
    facts: parsed.facts,
  });
});
it("does not treat a script translation as printed facts", () => {
  const without = html.replace(
    /<section data-testid="Accordion_supplement_facts">.*?<\/section>/s,
    '<script>{"heading":"Supplement Facts Serving Size 1 Softgel CoQ10 300 mg Other Ingredients: gelatin"}</script>',
  );
  const parsed = adapter.parseProduct({ ...page, html: without });
  expect(parsed.facts).toMatchObject({ text: null, complete: false });
  expect(parsed.evidence.imageCandidates).toHaveLength(2);
});
it.each(["Nutrition Facts", "Drug Facts"])("retains printed %s as a facts candidate", (heading) => {
  const parsed = adapter.parseProduct({ ...page, html: html.replace("Supplement Facts", heading) });
  expect(parsed.facts.text).toContain(heading);
});
it("does not infer online identity from the warehouse sku or the request URL", () => {
  expect(
    adapter.pageIdentity?.({
      ...page,
      url: "https://www.costco.com/other.product.4000100002.html",
    }),
  ).toEqual({ listingId: "100029983", variantId: null });
  expect(() => adapter.pageIdentity?.({ ...page, html: "<h1>CoQ10</h1>Item 648220" })).toThrow();
});
it("rejects a retained projection for another owner or URL", () => {
  const parsed = adapter.parseProduct(page);
  const planning = adapter.planning;
  if (!planning) {
    throw new Error("Planning missing");
  }
  expect(() =>
    planning.read(parsed.evidence, page.url, { listingId: "999", variantId: null }),
  ).toThrow();
  expect(() =>
    planning.read(
      parsed.evidence,
      "https://www.costco.com/other.product.999.html",
      parsed.identity,
    ),
  ).toThrow();
});
it("verifies the warehouse without changing it; permits absent product warehouse evidence", () => {
  expect(verifyCostcoStore(html, COSTCO_STORE, true)).toEqual({
    verified: true,
    shown: "Southlake",
  });
  expect(verifyCostcoStore("<h1>Product</h1>", COSTCO_STORE)).toEqual({
    verified: false,
    shown: null,
  });
  expect(() => verifyCostcoStore("<main>No results</main>", COSTCO_STORE, true)).toThrow();
  expect(() => verifyCostcoStore(html.replaceAll("Southlake", "Seattle"), COSTCO_STORE)).toThrow();
});
it("keeps incomplete facts for image fallback", () => {
  expect(
    adapter.parseProduct({ ...page, html: html.replace("Serving Size 1 Softgel", "Serving Size") })
      .facts.complete,
  ).toBe(false);
});
