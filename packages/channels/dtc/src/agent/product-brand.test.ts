import { expect, it } from "vitest";
import { capturedProductBrand } from "./product-brand.js";
import { dtcSitePolicy } from "../site-policy.js";

const url = "https://shop.example/products/zinc";
const input = {
  url,
  site: dtcSitePolicy({
    siteKey: "shop.example",
    platform: "shopify",
    catalogUrl: "https://shop.example/collections/all",
  }),
  record: {
    productUrl: url,
    fields: {},
    variants: [],
    gallery: [],
    pageHtml: "product.html",
    flags: [],
  },
};
function html(products: unknown[], canonical = url) {
  return Buffer.from(
    `<link rel="canonical" href="${canonical}">${products.map((product) => `<script type="application/ld+json">${JSON.stringify(product)}</script>`).join("")}`,
  );
}
const own = { "@type": "Product", url, brand: { name: "Website brand" } };

it("recovers the exact product brand from saved HTML without adopting recommendation brands", () => {
  expect(
    capturedProductBrand({
      ...input,
      html: html([own, { ...own, url: url + "-other", brand: "Other" }]),
    }),
  ).toBe("Website brand");
});

it("reads a ProductGroup brand independently of its selected variant", () => {
  expect(
    capturedProductBrand({
      ...input,
      html: html([
        {
          ...own,
          "@type": "ProductGroup",
          hasVariant: [
            { "@type": "Product", sku: "one" },
            { "@type": "Product", sku: "two" },
          ],
        },
      ]),
    }),
  ).toBe("Website brand");
});

it.each(["missing", "foreign", "ambiguous", "redirect"])(
  "keeps %s brand evidence unverified",
  (kind) => {
    const products =
      kind === "missing"
        ? []
        : kind === "foreign"
          ? [{ ...own, url: url + "-other" }]
          : kind === "ambiguous"
            ? [own, { ...own, brand: "Conflicting brand" }]
            : [own];
    expect(
      capturedProductBrand({
        ...input,
        html: html(products, kind === "redirect" ? url + "-other" : url),
      }),
    ).toBeNull();
  },
);

it("never overwrites a captured different brand with the expected brand", () => {
  expect(
    capturedProductBrand({
      ...input,
      record: { ...input.record, fields: { brand: "Captured other brand" } },
      html: html([own]),
    }),
  ).toBe("Captured other brand");
});
