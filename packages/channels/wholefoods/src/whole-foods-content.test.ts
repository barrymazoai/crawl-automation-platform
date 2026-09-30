import { expect, it } from "vitest";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { wholeFoodsAdapter } from "./whole-foods-adapter.js";
import { WHOLE_FOODS_STORE } from "./whole-foods-store.js";

const url = "https://www.wholefoodsmarket.com/grocery/product/oil-b0096m5pbw";
const ALAMEDA = `<script type="application/json">{"storePreference":{"buid":"10259","storeName":"The Alameda"}}</script>`;
const parse = (markup: string) =>
  wholeFoodsAdapter(WHOLE_FOODS_STORE).parseProduct({
    url,
    capturedAt: "2026-09-30T00:00:00Z",
    html: `<html><body><header>Delivering to 95126</header>${ALAMEDA}<main>
    <h1>Fish Oil</h1><p>$24.21</p>${markup}</main></body></html>`,
  });
const product = {
  "@type": "Product",
  name: "Fish Oil",
  sku: "B0096M5PBW",
  url,
  brand: { "@type": "Brand", name: "Nordic Naturals" },
  image: ["https://images.example/oil.jpg", { contentUrl: "https://images.example/label.jpg" }],
  ingredients: ["Fish oil", "Gelatin"],
  nutrition: { "@type": "NutritionInformation", servingSize: "2 softgels" },
};

it("retains JSON-LD brand, images and facts without planning a Whole Foods formula", () => {
  const parsed = parse(
    `<script type="application/ld+json">${JSON.stringify({ "@graph": [product] })}</script>`,
  );
  expect(parsed.evidence.brandRaw).toBe("Nordic Naturals");
  expect(parsed.evidence.imageCandidates).toHaveLength(2);
  expect(parsed.facts.text).toContain("Ingredients: Fish oil, Gelatin");
  expect(parsed.facts.text).toContain("servingSize: 2 softgels");
  expect(parsed.facts.complete).toBe(false);
  expect(ChannelProductEvidenceSchema.safeParse(parsed.evidence).success).toBe(true);
});

it("reads an optional Next.js product, never unrelated recommendations", () => {
  const props = {
    props: { pageProps: { product, recommendations: [{ ...product, brand: "Other" }] } },
  };
  expect(
    parse(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(props)}</script>`)
      .evidence.brandRaw,
  ).toBe("Nordic Naturals");
});

it("uses documented brand navigation and ingredient/nutrition sections", () => {
  const parsed = parse(`<nav><a href="/grocery/search?k=Nordic">Nordic Naturals</a></nav>
    <img src="/oil.jpg"><section><h2>Ingredients</h2><p>Fish oil.</p></section>
    <section><h2>Nutrition Facts</h2><p>Serving Size 2 capsules</p></section>`);
  expect(parsed.evidence.brandRaw).toBe("Nordic Naturals");
  expect(parsed.evidence.imageCandidates[0]?.url).toBe("https://www.wholefoodsmarket.com/oil.jpg");
  expect(parsed.evidence.factsCandidates[0]?.html).toContain("Fish oil.");
  expect(parsed.facts.text).toContain("Serving Size 2 capsules");
});

it.each([
  "",
  '<script id="__NEXT_DATA__">{broken</script>',
  '<script type="application/ld+json">null</script>',
])("keeps missing or malformed optional metadata safe: %s", (markup) => {
  const parsed = parse(markup);
  expect(parsed.evidence).toMatchObject({
    brandRaw: null,
    imageCandidates: [],
    factsCandidates: [],
  });
  expect(parsed.facts.text).toBeNull();
  expect(parsed.commerce?.price).toBe("$24.21");
});

it("does not associate a different product's JSON-LD with this ASIN", () => {
  const other = { ...product, sku: "B000000001", url: url.replace("b0096m5pbw", "b000000001") };
  const parsed = parse(`<script type="application/ld+json">${JSON.stringify(other)}</script>`);
  expect(parsed.evidence.brandRaw).toBeNull();
  expect(parsed.evidence.imageCandidates).toEqual([]);
});

it("ignores malformed optional product addresses and non-image URL schemes", () => {
  const invalid = { ...product, url: "javascript:alert(1)" };
  expect(
    parse(`<script type="application/ld+json">${JSON.stringify(invalid)}</script>`).evidence
      .brandRaw,
  ).toBeNull();
  const images = { ...product, image: ["javascript:alert(1)", "https://images.example/oil.jpg"] };
  expect(
    parse(`<script type="application/ld+json">${JSON.stringify(images)}</script>`).evidence
      .imageCandidates,
  ).toHaveLength(1);
});

it("leaves price and availability absent when the page does not show them", () => {
  const parsed = wholeFoodsAdapter(WHOLE_FOODS_STORE).parseProduct({
    url,
    capturedAt: "2026-09-30T00:00:00Z",
    html: `<html><body><header>Delivering to 95126</header>${ALAMEDA}<main><h1>Fish Oil</h1></main></body></html>`,
  });
  expect(parsed.commerce).toMatchObject({
    price: null,
    availability: null,
    priceStatus: "not_observed",
  });
});
