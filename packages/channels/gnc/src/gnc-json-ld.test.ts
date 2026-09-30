import { describe, expect, it } from "vitest";
import { gncAdapter } from "./gnc-adapter.js";
import { gncCommerce } from "./gnc-commerce.js";
import { allElements, gncDocument } from "./gnc-dom.js";
import { gncPageIdentity } from "./gnc-identity.js";
import { jsonLdProducts, productRecord, type JsonRecord } from "./gnc-json-ld.js";
import { parseGncProduct } from "./gnc-product.js";

const url = "https://www.gnc.com/fish-oil/123456.html";
const product = {
  "@type": "Product",
  sku: "123456",
  name: "Test omega",
  image: "https://www.gnc.com/omega.jpg",
};
const standalone = {
  ...product,
  "@context": "https://schema.org",
  "@id": "family",
  url: "",
  image: [product.image],
  brand: { "@type": "Brand", name: "Test brand" },
  aggregateRating: { ratingValue: "4.5", reviewCount: "290" },
};
const variant = {
  ...product,
  count: "60 Softgels",
  offers: { "@type": "Offer", url, price: 29.99, priceCurrency: "USD" },
};
const ld = (record: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(record)}</script>`;
const html = ld(standalone) + ld({ "@type": "ProductGroup", hasVariant: [variant] });
const page = (source: string) => ({ html: source, url, capturedAt: "2026-09-30T00:00:00.000Z" });

describe("GNC repeated JSON-LD SKU", () => {
  it("merges standalone and ProductGroup evidence without changing the inputs", () => {
    const { products } = jsonLdProducts(allElements(gncDocument(html)));
    const before = JSON.stringify(products);
    const merged = productRecord(products, product.sku);
    expect(merged).toMatchObject({ brand: { name: "Test brand" }, offers: { price: 29.99 } });
    expect(merged.count).toBe("60 Softgels");
    expect(productRecord([...products].reverse(), product.sku)).toEqual(merged);
    expect(JSON.stringify(products)).toBe(before);
  });

  it("uses the merged product in identity, adapter metrics and the planning projection", () => {
    const parsed = gncAdapter.parseProduct(page(html));
    expect(parsed.identity).toEqual({ listingId: product.sku, variantId: null });
    expect(parsed.commerce).toMatchObject({
      price: "29.99",
      currency: "USD",
      rating: "4.5",
      reviewCount: "290",
      priceStatus: "observed",
    });
    const planning = gncAdapter.planning;
    const planned = planning?.read(planning.projection(parsed.rendered), url, parsed.identity);
    expect(planned?.evidence.brandRaw).toBe("Test brand");
  });

  it("merges nested offer fields and normalizes singleton arrays and bookkeeping", () => {
    const first = { ...standalone, offers: [{ price: 29.99, url: "", "@id": "one" }] };
    const second = { ...variant, "@context": "http://schema.org/", "@id": "two" };
    expect(productRecord([first, second], product.sku)).toMatchObject({
      image: product.image,
      offers: { url, price: 29.99, priceCurrency: "USD" },
    });
  });

  it.each([
    ["price", { offers: { ...variant.offers, price: 39.99 } }],
    ["title", { name: "Another omega" }],
    ["image", { image: "https://www.gnc.com/another.jpg" }],
    ["offer URL", { offers: { ...variant.offers, url: "https://www.gnc.com/654321.html" } }],
  ] satisfies [string, JsonRecord][])("refuses a real %s conflict everywhere", (_name, changed) => {
    const source =
      ld(variant) + ld({ "@type": "ProductGroup", hasVariant: [{ ...variant, ...changed }] });
    const error = expect.objectContaining({ code: "GNC.SKU_AMBIGUOUS" });
    expect(() => productRecord([variant, { ...variant, ...changed }], product.sku)).toThrowError(
      error,
    );
    expect(() => gncPageIdentity(page(source))).toThrowError(error);
    expect(() => parseGncProduct(source, url, product.sku)).toThrowError(error);
    expect(() => gncCommerce(source, product.sku)).toThrowError(error);
  });
});
