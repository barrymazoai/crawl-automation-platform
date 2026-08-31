import { describe, expect, it } from "vitest";
import { isGncCaptureIncomplete, isGncDiscoveryIncomplete } from "./completeness.js";

describe("GNC fixed-adapter completeness gates", () => {
  it("accepts an exhausted 48-result brand catalog", () => {
    expect(isGncDiscoveryIncomplete({
      foundCount: 48,
      expectedCount: 48,
      maxItems: 500,
      exhausted: true,
      nextUrl: null,
    })).toBe(false);
  });

  it.each([
    { foundCount: 47, expectedCount: 48, exhausted: true, nextUrl: null },
    { foundCount: 30, expectedCount: 48, exhausted: false, nextUrl: "https://www.gnc.com/brand/?start=30&sz=30" },
    { foundCount: 500, expectedCount: 501, exhausted: false, nextUrl: "https://www.gnc.com/brand/?start=500&sz=30" },
  ])("rejects a partial catalog: %o", (value) => {
    expect(isGncDiscoveryIncomplete({ ...value, maxItems: 500 })).toBe(true);
  });

  it("rejects a SKU queue when newly discovered variants did not all run", () => {
    expect(isGncCaptureIncomplete({
      processedUrlCount: 48,
      queuedUrlCount: 49,
      productCount: 48,
      maxItems: 500,
      variantOverflow: false,
    })).toBe(true);
  });
});
