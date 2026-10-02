import { expect, it } from "vitest";
import { readJsonLdProduct, readShopifyProduct } from "@crawl-automation/channels-core";
import { dtcDocument } from "./product.js";

const url = "https://shop.example/products/vitamins";
const context = { url, siteKey: "shop.example", imageOrigins: ["https://shop.example"] };
function variant(id: string, price: string) {
  return {
    "@type": "Product",
    name: `Vitamins ${id}`,
    sku: `sku-${id}`,
    image: `${context.imageOrigins[0]}/${id}.jpg`,
    offers: { url: `${url}?variant=${id}`, price, priceCurrency: "USD" },
  };
}
function group() {
  return {
    "@type": "ProductGroup",
    url,
    name: "Vitamins",
    brand: { name: "Example" },
    description: "The group's product description",
    productGroupID: "1500",
    hasVariant: [variant("101", "9.99"), variant("102", "34.99")],
  };
}
const selected = (id: string) => `<form action="/cart/add"><input name="id" value="${id}"></form>`;
function page(record: unknown = group(), body = selected("102")) {
  return dtcDocument(`<html><head><link rel="canonical" href="${url}"></head><body>
    <script type="application/ld+json">${JSON.stringify(record)}</script>
    <section id="MainProduct-test">${body}</section></body></html>`);
}
const identityError = expect.objectContaining({ code: "DTC.IDENTITY_UNVERIFIED" });

it("reads a ProductGroup's rendered selection and retains all observed variants (synthetic HMW shape)", () => {
  const product = readShopifyProduct(page(), context);
  expect(product).toMatchObject({
    platform: "shopify",
    productId: "1500",
    url,
    title: "Vitamins 102",
    brandRaw: "Example",
    selectedVariantId: "102",
    detailsHtml: "The group's product description",
    commerce: { price: "34.99", currency: "USD", sku: "sku-102" },
    variants: [
      { id: "101", price: "9.99" },
      { id: "102", price: "34.99" },
    ],
  });
  expect(product.images).toContain("https://shop.example/102.jpg");
});

it("uses the rendered selected variant, not a conflicting requested query", () => {
  expect(
    readJsonLdProduct(page(), { ...context, url: `${url}?variant=101` }).selectedVariantId,
  ).toBe("102");
});

it("ignores recommendation groups on another canonical page and their forms", () => {
  const other = { ...group(), url: "https://shop.example/products/other" };
  const body = `${selected("102")}<product-recommendations>${selected("999")}</product-recommendations>`;
  expect(
    readJsonLdProduct(page({ "@graph": [other, group()] }, body), context).selectedVariantId,
  ).toBe("102");
});

it.each(["", selected("999"), selected("101") + selected("102")])(
  "refuses a missing, unknown, or conflicting rendered selection: %s",
  (body) => expect(() => readJsonLdProduct(page(group(), body), context)).toThrow(identityError),
);

it("does not resolve two independent products just because one matches a selected form", () => {
  const records = group().hasVariant.map((product) => ({ ...product, url }));
  expect(() => readJsonLdProduct(page(records), context)).toThrow(identityError);
});

it("refuses multiple groups or an independent product sharing the canonical URL", () => {
  for (const records of [
    [group(), group()],
    [group(), { ...variant("102", "34.99"), url }],
  ]) {
    expect(() => readJsonLdProduct(page(records), context)).toThrow(identityError);
  }
});

it("refuses duplicate variant identifiers", () => {
  expect(() =>
    readJsonLdProduct(
      page({ ...group(), hasVariant: [variant("102", "10"), variant("102", "20")] }),
      context,
    ),
  ).toThrow(identityError);
});

it("refuses missing or foreign-page variant offers", () => {
  for (const offers of [{}, { url: "https://other.example/products/vitamins?variant=102" }]) {
    expect(() =>
      readJsonLdProduct(
        page({ ...group(), hasVariant: [{ ...variant("102", "10"), offers }] }),
        context,
      ),
    ).toThrow(identityError);
  }
});

it("preserves variant properties over inherited group properties", () => {
  const own = {
    ...variant("102", "10"),
    brand: { name: "Specific" },
    description: "Variant details",
  };
  expect(readJsonLdProduct(page({ ...group(), hasVariant: [own] }), context)).toMatchObject({
    brandRaw: "Specific",
    detailsHtml: "Variant details",
  });
});
