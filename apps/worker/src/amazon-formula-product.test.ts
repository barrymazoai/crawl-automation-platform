import { expect, it } from "vitest";
import { amazonAdapter } from "@crawl-automation/channel-amazon";
import { amazonFormulaProduct } from "./amazon-formula-product.js";

it("queues the same canonical ASIN URL as the Amazon adapter", () => {
  const product = amazonFormulaProduct("b0096m5pbw", "amazon-source");
  expect(product).toEqual({
    sourceId: "amazon-source",
    listingId: "B0096M5PBW",
    variantId: null,
    url: amazonAdapter.productUrl?.("B0096M5PBW"),
  });
  expect(amazonAdapter.productAddress(product.url).listingId).toBe(product.listingId);
});

it("rejects an invalid shared ASIN before it can enter the queue", () => {
  expect(() => amazonFormulaProduct("not-an-asin", "source")).toThrow();
});
