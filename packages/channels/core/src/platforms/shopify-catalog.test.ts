import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readShopifyCatalogPage } from "./shopify-catalog.js";

const corpus = fileURLToPath(
  new URL("../../../../../tools/diag-corpus/round9/catalog/", import.meta.url),
);
const hasCorpus = existsSync(`${corpus}/sambucol.page.html`);

describe("retained Shopify products.json pages", () => {
  it.skipIf(!hasCorpus).each([
    ["bloodsugarfriendly", 6, 6],
    ["sambucol", 22, 22],
    ["auri", 5, 14],
    ["tally", 17, 34],
    ["womaness", 43, 52],
    ["katefarms", 19, 48],
    ["energi", 81, 81],
    ["natrol", 46, 65],
    ["jarrow", 104, 146],
  ])("parses %s as %i products and %i variants", (name, products, variants) => {
    const parsed = readShopifyCatalogPage(readFileSync(`${corpus}/${name}.json`, "utf8"));
    expect(parsed).toHaveLength(products);
    expect(parsed.reduce((count, product) => count + product.variants.length, 0)).toBe(variants);
    expect(
      parsed.every((product) => product.variants.every((variant) => variant.id && variant.title)),
    ).toBe(true);
  });

  it("parses an empty page after the last one as no products", () => {
    expect(readShopifyCatalogPage('{"products":[]}')).toEqual([]);
  });

  it.each([undefined, "not JSON", "{}", '{"products":{}}', '{"products":[{"id":1}]}'])(
    "rejects a malformed catalog body: %s",
    (body) => {
      expect(() => readShopifyCatalogPage(body)).toThrowError(
        expect.objectContaining({ code: "DTC.CATALOG_JSON_INVALID" }),
      );
    },
  );

  it.each([
    { variants: [] },
    { variants: [{ title: "Default Title" }] },
    { variants: [{ id: 1, title: "" }] },
    { variants: [{ id: 1, title: "Default Title", available: "yes" }] },
  ])("rejects a product with invalid variants: $variants", ({ variants }) => {
    const body = JSON.stringify({ products: [{ id: 1, handle: "one", title: "One", variants }] });
    expect(() => readShopifyCatalogPage(body)).toThrowError(
      expect.objectContaining({ code: "DTC.CATALOG_JSON_INVALID" }),
    );
  });
});
