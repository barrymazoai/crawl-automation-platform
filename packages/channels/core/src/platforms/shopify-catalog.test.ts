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
    ["bloodsugarfriendly", 6],
    ["sambucol", 22],
    ["auri", 5],
    ["tally", 17],
    ["womaness", 43],
    ["katefarms", 19],
    ["energi", 81],
    ["natrol", 46],
    ["jarrow", 104],
  ])("parses %s as %i products", (name, count) => {
    expect(readShopifyCatalogPage(readFileSync(`${corpus}/${name}.json`, "utf8"))).toHaveLength(
      count,
    );
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
});
