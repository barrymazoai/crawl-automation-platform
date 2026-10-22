import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  completeFacts,
  readJsonLdProduct,
  readShopifyProduct,
  readWooCommerceProduct,
} from "@crawl-automation/channels-core";
import { dtcDocument } from "./product.js";
import { dtcEvidence } from "./evidence.js";
import { dtcBrandEvidence } from "./brand-evidence.js";
import { dtcSitePolicy } from "./site-policy.js";

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

const solarayUrl = "https://solaray.com/products/cool-cayenne-pepper-40-000-hu";
const solarayContext = {
  url: solarayUrl,
  siteKey: "solaray.com",
  imageOrigins: ["https://solaray.com"],
};

/** Trimmed from the retained Solaray product root and embedded Shopify record. */
function solarayPage(description: string, extraAccordion = "") {
  const record = {
    id: 4478045192252,
    handle: "cool-cayenne-pepper-40-000-hu",
    title: "Cool Cayenne Pepper 40,000 Hu",
    description,
    variants: [{ id: 31889305862204, title: "90ct", price: 1069, available: true }],
    images: [],
  };
  return dtcDocument(`<html><head><link rel="canonical" href="${solarayUrl}"></head><body>
    <main id="MainContent"><div class="product">
      <ul class="product__media-list"></ul><form action="/cart/add"></form>
      <div id="ProductInfo-template--23952999579708__main">
        <div class="product__description rte"><!----></div>
        <div class="product__accordion accordion"><details open>
          <summary><h2>Ingredients</h2></summary><div class="accordion__content rte">
            <p>Cayenne (Capsicum annuum) (pepper), Cellulose, Vegetable Cellulose Capsule,
              Annatto (seed extract), Ginger (root) and Guar Gum.</p>
          </div></details></div>
        <div class="product__accordion accordion"><details open>
          <summary><h2>Directions</h2></summary><div class="accordion__content rte">
            <p>Use only as directed. Take 2 VegCaps daily with a meal or glass of water.</p>
          </div></details></div>
        ${extraAccordion}
        <div inert><div class="description">Complete Your Supplement Stack</div></div>
      </div></div><section><h2>Our story</h2><p>Not this product</p></section></main>
      <script type="application/json">${JSON.stringify(record)}</script></body></html>`);
}

describe("platform reader boundary cases (synthetic)", () => {
  it("uses Solaray's rendered Ingredients and Directions when Shopify description is a comment", () => {
    const product = readShopifyProduct(solarayPage("<!---->"), solarayContext);
    expect(product.detailsHtml).toContain("Cayenne (Capsicum annuum)");
    expect(product.detailsHtml).toContain("Take 2 VegCaps daily");
    expect(product.detailsHtml).not.toContain("Complete Your Supplement Stack");
    expect(product.detailsHtml).not.toContain("Not this product");
    expect(product.factsHtml).toBeNull();
    expect(product.facts.complete).toBe(false);
  });

  it("preserves a non-empty Shopify description", () => {
    const product = readShopifyProduct(
      solarayPage('<p>Stored product description <img src="/description.jpg"></p>'),
      solarayContext,
    );
    expect(product.detailsHtml).toBe(
      '<p>Stored product description <img src="/description.jpg"></p>',
    );
    expect(product.images).toContain("https://solaray.com/description.jpg");
  });

  it("keeps images from a text-empty Shopify description during rendered-details fallback", () => {
    const product = readShopifyProduct(solarayPage('<img src="/description.jpg">'), solarayContext);
    expect(product.detailsHtml).toContain("Take 2 VegCaps daily");
    expect(product.images).toContain("https://solaray.com/description.jpg");
  });

  it("still selects a complete rendered Supplement Facts panel with an empty description", () => {
    const panel = `<div class="product__accordion accordion"><details>
      <summary>Supplement Facts</summary><div>${[
        "Serving Size: 2 VegCaps",
        "Cayenne 100 mg",
        "Other Ingredients: cellulose",
      ].join("<br>")}</div></details></div>`;
    const product = readShopifyProduct(solarayPage("<!---->", panel), solarayContext);
    expect(product.factsHtml).toContain("Supplement Facts");
    expect(product.facts.complete).toBe(true);
    expect(product.facts.text).toContain("Cayenne 100 mg");
  });

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

const kateSite = dtcSitePolicy({
  siteKey: "shop.katefarms.com",
  platform: "shopify",
  catalogUrl: null,
});
const katePages = [
  {
    id: "5247029e3337cbe9",
    title: "Pediatric Peptide 1.0",
    calories: "250kcal",
    sodium: "160mg",
    protein: "9g",
  },
  {
    id: "fbe7438d1522a706",
    title: "Pediatric Peptide 1.5",
    calories: "375kcal",
    sodium: "200mg",
    protein: "13g",
  },
  {
    id: "126a4ade76669973",
    title: "Pediatric Standard 1.2",
    calories: "300kcal",
    sodium: "160mg",
    protein: "12g",
  },
] as const;

describe("retained Kate Farms medical nutrition pages", () => {
  it.each(katePages)(
    "retains the $id nutrition table and sibling Ingredients tab",
    ({ id, title, calories, sodium, protein }) => {
      const html = readFileSync(
        new URL(
          `../../../../tools/diag-corpus/round8/html/nosource-katefarms--dtc-${id}.html`,
          import.meta.url,
        ),
        "utf8",
      );
      const document = dtcDocument(html);
      const url = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
      expect(url).toBeTruthy();
      if (!url) {
        throw new Error("retained page has no canonical product URL");
      }
      const product = readShopifyProduct(document, {
        url,
        siteKey: kateSite.siteKey,
        imageOrigins: [...kateSite.imageOrigins],
      });
      const evidence = dtcEvidence(
        product,
        kateSite,
        dtcBrandEvidence(kateSite, product.brandRaw, null),
      );
      expect(product.title).toContain(title);
      expect(evidence.factsCandidates).toHaveLength(1);
      expect(product.facts.complete).toBe(true);
      expect(product.facts.missing).toEqual([]);
      expect(product.facts.text).toContain(`Calories\t${calories}`);
      expect(product.facts.text).toContain(`Sodium\t${sodium}`);
      expect(product.facts.text).toContain(`Protein\t${protein}`);
      expect(product.facts.text).toContain("Ingredients: Purified Water");
      expect(product.facts.text).not.toMatch(/Serving Size/i);
      if (id === "5247029e3337cbe9") {
        expect(product.facts.text).toContain("Strawberry Flavor");
        expect(product.facts.text).not.toContain("Vanilla Extract");
      }
      if (id === "126a4ade76669973") {
        expect(product.facts.text).toContain("Dietary Fiber\t4g");
        expect(product.facts.text).not.toContain("Dietary Fiber\t5g");
      }
    },
  );
});
