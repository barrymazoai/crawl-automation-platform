import { afterEach, expect, it, vi } from "vitest";
import { applyDetailExtractionProfile, extractDetailDomRecord } from "./engine.mjs";
import { extractProductsBatch, upgradeProducts } from "./crawl.mjs";
import { withNativeExtractionBoundary } from "./native-extraction-boundary.mjs";
import { extractIngredientsFromBody } from "./shopify-http.mjs";

afterEach(() => vi.unstubAllEnvs());
it("blocks generic extraction in the native CLI before hooks or browser actions", async () => {
  vi.stubEnv("CRAWL_DTC_CAPTURE_MODE", "product");
  expect(() => applyDetailExtractionProfile({})).toThrow("DTC.GENERIC_EXTRACTION_FORBIDDEN");
  expect(() => extractDetailDomRecord("https://test", "")).toThrow("DTC.GENERIC_EXTRACTION_FORBIDDEN");
  expect(() => extractIngredientsFromBody("Ingredients: guess")).toThrow("DTC.GENERIC_EXTRACTION_FORBIDDEN");
  await expect(extractProductsBatch(null, [])).rejects.toThrow("DTC.GENERIC_EXTRACTION_FORBIDDEN");
  await expect(upgradeProducts(null, [])).rejects.toThrow("DTC.GENERIC_EXTRACTION_FORBIDDEN");
});
it("blocks nested native hooks while preserving unrelated legacy execution", async () => {
  await withNativeExtractionBoundary(true, async () => {
    await Promise.resolve();
    expect(() => extractDetailDomRecord("https://test", "")).toThrow("DTC.GENERIC_EXTRACTION_FORBIDDEN");
  });
  expect(() => extractDetailDomRecord("https://test", "<h1>Legacy product</h1>")).not.toThrow();
});
