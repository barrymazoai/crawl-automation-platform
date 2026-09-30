import { expect, it, vi } from "vitest";
import { amazonProductForAsin } from "./amazon-formula-gap.js";

it("gets the Amazon URL from the injected adapter, preserving the queue identity", () => {
  const productUrl = vi.fn((asin: string) => `https://adapter.example/products/${asin}`);
  expect(amazonProductForAsin("b0096m5pbw", "source", productUrl)).toEqual({
    sourceId: "source",
    listingId: "B0096M5PBW",
    variantId: null,
    url: "https://adapter.example/products/B0096M5PBW",
  });
  expect(productUrl).toHaveBeenCalledWith("B0096M5PBW");
});
