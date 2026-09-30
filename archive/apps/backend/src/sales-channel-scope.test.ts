import { describe, expect, it } from "vitest";
import { decideSalesChannelScope } from "./sales-channel-scope.js";

describe("shared sales-channel catalog scope", () => {
  it.each(["amazon", "gnc", "swanson"])("allows an exhausted %s brand catalog to be full", () => {
    expect(decideSalesChannelScope({
      inputKind: "brand_catalog",
      exhausted: true,
      truncated: false,
      expectedCount: 48,
      discoveredCount: 48,
      processedCount: 48,
    })).toEqual({ scope: "full", reasons: [] });
  });

  it.each(["product", "search"] as const)("keeps a %s input partial", (inputKind) => {
    expect(decideSalesChannelScope({
      inputKind,
      exhausted: true,
      truncated: false,
      expectedCount: 1,
      discoveredCount: 1,
      processedCount: 1,
    }).scope).toBe("partial");
  });

  it("downgrades every channel when pagination, counts, or processing are incomplete", () => {
    const result = decideSalesChannelScope({
      inputKind: "brand_catalog",
      exhausted: false,
      truncated: true,
      expectedCount: 50,
      discoveredCount: 48,
      processedCount: 47,
    });
    expect(result.scope).toBe("partial");
    expect(result.reasons).toEqual([
      "catalog_not_exhausted",
      "catalog_truncated",
      "catalog_count_mismatch:48/50",
      "catalog_items_unprocessed:47/48",
    ]);
  });
});
