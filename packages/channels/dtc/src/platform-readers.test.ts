import { describe, expect, it } from "vitest";
import {
  completeFacts,
  readJsonLdProduct,
  readWooCommerceProduct,
} from "@crawl-automation/channels-core";
import { dtcDocument } from "./product.js";

const url = "https://woo.example/product/magnesium";
const context = { url, siteKey: "woo.example", imageOrigins: ["https://woo.example"] };
const schema = {
  "@type": "Product",
  name: "Magnesium",
  sku: "sku-9",
  url,
  image: `${context.imageOrigins[0]}/front.jpg`,
  offers: {
    "@type": "Offer",
    price: "29.50",
    priceCurrency: "USD",
    availability: "https://schema.org/OutOfStock",
  },
};
function documentWith(product: object, body = "") {
  return dtcDocument(`<html><head><link rel="canonical" href="${url}"></head><body>
    <script type="application/ld+json">${JSON.stringify(product)}</script>${body}</body></html>`);
}

describe("platform reader boundary cases (synthetic)", () => {
  it("reads WooCommerce variation JSON and the rendered selected variation", () => {
    const variations = [
      {
        variation_id: 901,
        display_price: 25,
        is_in_stock: true,
        attributes: { attribute_size: "60" },
      },
      {
        variation_id: 902,
        display_price: 40,
        is_in_stock: false,
        attributes: { attribute_size: "120" },
      },
    ];
    const body = `<form class="variations_form" data-product_id="90" data-product_variations='${JSON.stringify(variations)}'><input name="variation_id" value="902"></form>`;
    const product = readWooCommerceProduct(documentWith(schema, body), context);
    expect(product.productId).toBe("90");
    expect(product.selectedVariantId).toBe("902");
    expect(product.variants).toHaveLength(2);
    expect(product.variants[1]?.url).toContain("attribute_size=120");
    expect(product.commerce).toMatchObject({
      price: "40",
      availability: "OutOfStock",
      currency: "USD",
    });
  });
  it("refuses WooCommerce variations deferred to an uncaptured AJAX call", () => {
    const body =
      '<form class="variations_form" data-product_id="90" data-product_variations="false"></form>';
    expect(() => readWooCommerceProduct(documentWith(schema, body), context)).toThrow();
  });
  it("reads simple WooCommerce products", () => {
    const product = readWooCommerceProduct(
      documentWith(schema, '<button name="add-to-cart" value="90">Add</button>'),
      context,
    );
    expect(product.productId).toBe("90");
    expect(product.commerce).toMatchObject({ price: "29.50", availability: "OutOfStock" });
  });
  it("selects the canonical JSON-LD product and ignores recommendations in the graph", () => {
    const document = documentWith({
      "@graph": [schema, { ...schema, url: "https://woo.example/product/other", name: "Other" }],
    });
    expect(readJsonLdProduct(document, context).title).toBe("Magnesium");
  });
  it("refuses ambiguous product identities", () => {
    const document = documentWith([schema, { ...schema, sku: "other" }]);
    expect(() => readJsonLdProduct(document, context)).toThrow();
  });
  it("does not manufacture a price for AggregateOffer ranges", () => {
    const document = documentWith({
      ...schema,
      offers: { "@type": "AggregateOffer", lowPrice: 10, highPrice: 40, priceCurrency: "USD" },
    });
    expect(readJsonLdProduct(document, context).commerce.price).toBeNull();
  });
  it.each([
    "Serving Size Amount per serving Other Ingredients",
    "Serving Size 1 capsule Other Ingredients cellulose",
    "Magnesium 100 mg Other Ingredients cellulose",
    "Serving Size 1 capsule Magnesium 100 mg",
    "Serving Size 1 capsule Daily Value 100% Other Ingredients cellulose",
  ])("keeps incomplete facts on the image path: %s", (text) => {
    expect(completeFacts(text).complete).toBe(false);
  });
});
