import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { errorCodeOf } from "@crawl-automation/platform";
import { describe, expect, it } from "vitest";
import { GNC_PAGE_LIMITS } from "./gnc-dom.js";
import { parseGncProduct } from "./gnc-product.js";

const url = "https://www.gnc.com/vitamins/123456.html";
const product = {
  "@type": "Product",
  sku: "123456",
  name: "Test vitamin",
  brand: { name: "Example" },
  image: "https://images.gnc.com/123456.jpg",
  offers: { url },
};
const ld = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const facts =
  '<div id="productIngredientsAccordionContent"><table><tr><th rowspan="2">Vitamin C</th><td>10 mg</td>' +
  "</tr></table><p>Other ingredients: cellulose</p></div>";
const html = ld(product) + facts;
const parse = (page: string) => parseGncProduct(page, url, "123456");
const imageUrls = (page: string) => parse(page).imageCandidates.map((image) => image.url);

function codeOf(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    return errorCodeOf(error);
  }
}

describe("GNC product page (synthetic pages carried over from the former parser)", () => {
  it("keeps the exact facts HTML and the product's own image, without PDFs", () => {
    const result = parse(html + '<a href="/123456_lbl.pdf">PDF</a>');
    expect(result.factsHtml).toBe(facts);
    expect(result.imageCandidates).toEqual([
      { url: product.image, basis: "sku-jsonld", verifiedOriginal: false },
    ]);
    expect(result.brandRaw).toBe("Example");
  });

  it("keeps incomplete facts; completeness is judged later", () => {
    const partial =
      '<div id="productIngredientsAccordionContent">Other ingredients: cellulose</div>';
    expect(parse(ld(product) + partial).factsHtml).toBe(partial);
  });

  it("does not invent missing facts or a brand", () => {
    const result = parse(ld({ ...product, brand: null }));
    expect(result.factsHtml).toBeNull();
    expect(result.brandRaw).toBeNull();
    expect(result.warnings).toContain("GNC.FACTS_DOM_MISSING");
  });

  it("takes the SKU's own product group as its sizes, never a recommendation", () => {
    const sibling = { ...product, sku: "234567", offers: { url: "/vitamins/234567.html" } };
    const recommendation = {
      ...product,
      sku: "999999",
      offers: { url: "/vitamins/999999.html" },
      image: "https://images.gnc.com/unrelated.jpg",
    };
    const data = [recommendation, { "@type": "ProductGroup", hasVariant: [product, sibling] }];
    const result = parse(ld(data) + facts);
    expect(result.variantUrls).toEqual(["https://www.gnc.com/vitamins/234567.html"]);
    expect(result.imageCandidates.map((image) => image.url)).toEqual([product.image]);
  });

  it.each([
    ["another SKU only", ld({ ...product, sku: "999999" }), "GNC.SKU_UNVERIFIED"],
    [
      "a size without its own page",
      ld({ "@type": "ProductGroup", hasVariant: [product, { ...product, sku: "234567" }] }),
      "GNC.SKU_CONFLICT",
    ],
    ["two records", ld([product, { ...product, name: "Different" }]), "GNC.SKU_AMBIGUOUS"],
    ["a foreign offer", ld({ ...product, offers: { url: "/999999.html" } }), "GNC.SKU_CONFLICT"],
    ["no title", ld({ ...product, name: "" }), "GNC.TITLE_MISSING"],
    ["two facts sections", html + facts, "GNC.DOM_AMBIGUOUS"],
    ["broken JSON", '<script type="application/ld+json">{broken</script>', "GNC.JSON_INVALID"],
  ])("refuses %s", (_name, page, code) => {
    expect(codeOf(() => parse(page))).toBe(code);
  });

  it("does not mistake a captcha library name for a challenge page", () => {
    expect(parse(html + '<script>PerimeterX("RateLimiter-HideCaptcha")</script>').sku).toBe(
      "123456",
    );
  });

  it.each(["<h1>Pardon Our Interruption</h1>", '<div id="px-captcha"></div>'])(
    "detects a real challenge: %s",
    (challenge) => {
      expect(codeOf(() => parse(html + challenge))).toBe("GNC.ACCESS_CHALLENGE");
    },
  );

  it("keeps only the product's gallery, never claiming original resolution", () => {
    const gallery =
      '<img src="/banner.jpg"><div id="product-images"><img src="/label.jpg?width=100">' +
      '<img src="/label.pdf"></div>';
    const result = parse(html + gallery);
    expect(result.imageCandidates.map((image) => image.url)).toEqual([
      product.image,
      "https://www.gnc.com/label.jpg?width=100",
    ]);
    expect(result.imageCandidates.every((image) => !image.verifiedOriginal)).toBe(true);
  });

  it("reads the current thumbnail grid from its explicit zoom URLs", () => {
    const img = (src: string, zoom: string) =>
      `<img alt="Test vitamin" src="${src}" data-zoom-url="${zoom}">`;
    const gallery =
      '<div class="product-thumbnails-grid d-none d-lg-flex">' +
      img("/123456-front.jpg?sw=480", "/123456-front.jpg?sw=1500&amp;sh=1500") +
      img("/123457-unit-back.jpg?sw=480", "/123457-unit-back.jpg?sw=1500") +
      img("/123457-unit-back.jpg?sw=480", "/123457-unit-back.jpg?sw=1500") +
      "</div>";
    expect(imageUrls(html + gallery)).toEqual([
      product.image,
      "https://www.gnc.com/123456-front.jpg?sw=1500&sh=1500",
      "https://www.gnc.com/123457-unit-back.jpg?sw=1500",
    ]);
  });

  it.each(["recommendation", "recommendations", "product-tile"])(
    "ignores galleries inside %s components",
    (wrapper) => {
      const gallery =
        '<div class="product-thumbnails-grid"><img alt="Test vitamin" src="/x.jpg"></div>';
      expect(imageUrls(html + `<div class="${wrapper}">${gallery}</div>`)).toEqual([product.image]);
    },
  );

  it("requires the product title and refuses another data-pid or a hidden template", () => {
    const gallery =
      '<div class="product-thumbnails-grid"><img alt="Test vitamin" src="/x.jpg"></div>';
    const others = [
      gallery.replace('alt="Test vitamin"', 'alt="Other vitamin"'),
      `<div data-pid="999999">${gallery}</div>`,
      `<template>${gallery}</template>`,
    ];
    for (const extra of others) {
      expect(imageUrls(html + extra)).toEqual([product.image]);
    }
  });

  it("refuses over-size and too deep pages instead of truncating them", () => {
    expect(codeOf(() => parse(" ".repeat(GNC_PAGE_LIMITS.maxBytes + 1)))).toBe("GNC.PAGE_LIMIT");
    expect(codeOf(() => parse("<div>".repeat(130) + html))).toBe("GNC.PAGE_LIMIT");
  });
});

describe("GNC product page (real page 877080)", () => {
  it("reads the SKU, its facts table and its images", () => {
    const page = gunzipSync(
      readFileSync(new URL("./fixtures/product-877080.html.gz", import.meta.url)),
    ).toString();
    const result = parseGncProduct(page, "https://www.gnc.com/vitamin-d/877080.html", "877080");
    expect(result.sku).toBe("877080");
    expect(result.factsHtml).toContain("productIngredientsAccordionContent");
    expect(result.imageCandidates.length).toBeGreaterThan(0);
  });
});
