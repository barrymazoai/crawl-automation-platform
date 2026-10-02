import { describe, expect, it } from "vitest";
import {
  readJsonLdProduct,
  readShopifyProduct,
  readWooCommerceProduct,
} from "@crawl-automation/channels-core";
import { dtcDocument } from "./product.js";
import { sectionContext, sectionFacts, sectionPage } from "./testing/product-sections.js";

it("uses WooCommerce's observed product ID when its JSON-LD identifies only a SKU", () => {
  const html = sectionPage({
    root: '<button name="add-to-cart" value="90">Add</button>',
    lower: '<section data-product_id="90"><img src="/woo-label.jpg"></section>',
  }).replace('data-product-id="123"', "");
  const product = readWooCommerceProduct(dtcDocument(html), sectionContext);
  expect(product.productId).toBe("90");
  expect(product.images.at(-1)).toBe("https://shop.example/woo-label.jpg");
});

describe.each([
  { platform: "Shopify", read: readShopifyProduct },
  { platform: "WooCommerce", read: readWooCommerceProduct },
  { platform: "JSON-LD", read: readJsonLdProduct },
])("own product sections: $platform", ({ read }) => {
  const parse = (options: Parameters<typeof sectionPage>[0]) =>
    read(dtcDocument(sectionPage(options)), sectionContext);

  it.each(["image_with_text", "rich_text", "collapsible_content", "multicolumn"])(
    "includes facts and label images from a lower %s section",
    (kind) => {
      const product = parse({
        lower: `<section id="shopify-section-template--1__${kind}">
      ${sectionFacts}<img data-src="/label.jpg"><img src="https://foreign.example/label.jpg">
      </section>`,
      });
      expect(product.facts.complete).toBe(true);
      expect(product.facts.text).toContain("Magnesium 100 mg");
      expect(product.images).toEqual([
        "https://shop.example/front.jpg",
        "https://shop.example/label.jpg",
      ]);
    },
  );

  it("reads facts already present in a closed lower details element", () => {
    const product = parse({
      lower: `<section class="shopify-section"><details>
      <summary>Supplement Facts</summary>${sectionFacts}<img src="/closed-label.jpg">
      </details></section>`,
    });
    expect(product.facts.complete).toBe(true);
    expect(product.images.at(-1)).toBe("https://shop.example/closed-label.jpg");
  });

  it.each(['data-product-id="123"', 'data-product-handle="magnesium"'])(
    "accepts exact product ownership %s without a label heading",
    (identity) => {
      const product = parse({
        lower: `<section ${identity}><img src="/owned-label.jpg"></section>`,
      });
      expect(product.images.at(-1)).toBe("https://shop.example/owned-label.jpg");
    },
  );

  it.each([
    '<section class="related-products"><h2>Supplement Facts</h2>',
    "<section><h2>You may also like</h2><h3>Supplement Facts</h3>",
    '<section data-product-id="999"><h2>Supplement Facts</h2>',
    '<section data-product-handle="other"><h2>Supplement Facts</h2>',
    '<section><h2>Supplement Facts</h2><a href="/products/other">Another product</a>',
    '<section class="reviews-widget"><h2>Supplement Facts</h2>',
    '<section class="blog"><h2>Supplement Facts</h2>',
    '<section role="dialog"><h2>Supplement Facts</h2>',
  ])("excludes foreign/nonproduct sections: %s", (start) => {
    const product = parse({ lower: `${start}${sectionFacts}<img src="/foreign.jpg"></section>` });
    expect(product.facts.complete).toBe(false);
    expect(product.images).toEqual(["https://shop.example/front.jpg"]);
  });

  it("removes a nested related panel before judging its parent's facts complete", () => {
    const product = parse({
      lower: `<section><h2>Supplement Facts</h2><p>Serving Size 2 capsules</p>
      <div class="related"><p>Another product 900 mg. Other Ingredients: wrong.</p><img src="/wrong.jpg"></div></section>`,
    });
    expect(product.facts.complete).toBe(false);
    expect(product.facts.text).not.toContain("900 mg");
    expect(product.images).toEqual(["https://shop.example/front.jpg"]);
  });

  it("excludes site headers, footers and unscoped marketing panels", () => {
    const panel = `${sectionFacts}<img src="/not-product.jpg">`;
    const product = parse({
      lower: '<section><h2>Our story</h2><img src="/story.jpg"></section>',
      outside: `<header><section>${panel}</section></header><footer><section>${panel}</section></footer>`,
    });
    expect(product.factsHtml).toBeNull();
    expect(product.images).toEqual(["https://shop.example/front.jpg"]);
  });

  it("joins one facts section with its separate Other Ingredients section", () => {
    const product = parse({
      lower: `<section><h2>Supplement Facts</h2><p>Serving Size 2 capsules</p>
      <p>Magnesium 100 mg</p></section><section><h2>Other Ingredients</h2><p>cellulose.</p></section>`,
    });
    expect(product.facts.complete).toBe(true);
  });

  it("preserves the root's complete facts and original image ordering", () => {
    const root = `<div class="facts">${sectionFacts}</div><img src="/label.jpg">`;
    const original = parse({ root });
    const unchanged = parse({
      root,
      lower: '<section><h2>Our story</h2><img src="/story.jpg"></section>',
    });
    expect(unchanged).toEqual(original);
    expect(unchanged.factsHtml).toBe(`<div class="facts">${sectionFacts}</div>`);
    expect(unchanged.images).toEqual([
      "https://shop.example/front.jpg",
      "https://shop.example/label.jpg",
    ]);
  });
});
