import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { costcoAdapter } from "./adapter.js";
import { parseCostcoListing } from "./listing.js";
import { COSTCO_STORE } from "./store.js";

const directory = process.env.COSTCO_FIXTURE_DIR;
function saved(name: string): string | null {
  const path = directory ? join(directory, name) : null;
  return path && existsSync(path) ? readFileSync(path, "utf8") : null;
}
const scenarios = [
  {
    file: "product-coq10-100029983.html",
    listingId: "100029983",
    itemNumber: "648220",
    price: "26.99",
    rating: "4.78",
    reviewCount: "8229",
    images: 3,
    title: "Kirkland Signature CoQ10 300 mg., 100 Softgels",
  },
  {
    file: "product-energy-shot-4000100002.html",
    listingId: "4000100002",
    itemNumber: "1711799",
    price: "35.99",
    rating: "4.65",
    reviewCount: "610",
    images: 1,
    title: "Kirkland Signature Extra Strength Energy Shot, 48 Bottles, 2 Ounces Each",
  },
];
for (const scenario of scenarios) {
  const html = saved(scenario.file);
  it.skipIf(!html)(`saved ${scenario.file} (requires COSTCO_FIXTURE_DIR)`, () => {
    const parsed = costcoAdapter().parseProduct({
      html: html ?? "",
      url: `https://www.costco.com/p/-/${scenario.listingId}`,
      capturedAt: "2026-10-01T00:00:00Z",
    });
    expect(parsed.identity.listingId).toBe(scenario.listingId);
    expect(parsed.evidence.title).toBe(scenario.title);
    expect(parsed.evidence.brandRaw).toBe("Kirkland Signature");
    expect(parsed.rendered).toMatchObject({
      itemNumber: scenario.itemNumber,
      warehouseId: "669",
      warehouseVerified: false,
    });
    expect(parsed.commerce).toMatchObject({
      price: scenario.price,
      rating: scenario.rating,
      reviewCount: scenario.reviewCount,
      // The raw page's JSON-LD stock is a placeholder; stock is not observed from it.
      availability: null,
    });
    expect(parsed.evidence.imageCandidates.length).toBeGreaterThanOrEqual(scenario.images);
    expect(parsed.evidence.imageCandidates.every((image) => image.url.endsWith(".jpg"))).toBe(true);
    expect(parsed.facts).toMatchObject({ text: null, complete: false });
  });
}
const listing = saved("brand-list-nature-made.html");
it.skipIf(!listing)("saved Nature Made listing (requires COSTCO_FIXTURE_DIR)", () => {
  const parsed = parseCostcoListing(listing ?? "", COSTCO_STORE);
  expect(parsed).toMatchObject({ soldHere: true, page: { cards: 23, statedTotal: 23 } });
  expect(parsed.page.products[0]?.listingId).toBe("4000061877");
  expect(new Set(parsed.page.products.map((product) => product.listingId)).size).toBe(23);
  expect(parsed.page.products.some((product) => product.listingId === "4000282374")).toBe(false);
});

const energy = saved("product-energy-shot-4000100002.html");
it.skipIf(!energy)(
  "retains the observed JPEG nutrition label and both online/delivered prices",
  () => {
    const parsed = costcoAdapter().parseProduct({
      html: energy ?? "",
      url: "https://www.costco.com/p/-/4000100002",
      capturedAt: "2026-10-01T00:00:00Z",
    });
    expect(parsed.evidence.imageCandidates).toHaveLength(4);
    expect(
      parsed.evidence.imageCandidates.some((image) => image.url.endsWith("1711799-847__1nf.jpg")),
    ).toBe(true);
    expect(parsed.rendered.prices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Online Price", price: "43.99" }),
        expect.objectContaining({ label: "Delivered Price", price: "35.99" }),
      ]),
    );
  },
);
