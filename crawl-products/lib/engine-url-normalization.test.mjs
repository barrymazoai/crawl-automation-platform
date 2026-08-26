import { describe, expect, it } from "vitest";
import { normalizeProductUrl } from "./engine.mjs";

describe("product URL normalization", () => {
  it("removes listing query identifiers while preserving product variants", () => {
    expect(normalizeProductUrl(
      "https://example.com/products/magnesium?qID=abc123&variant=42&utm_source=catalog#details",
    )).toBe("https://example.com/products/magnesium?variant=42");
  });
});
