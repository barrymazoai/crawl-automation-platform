import { describe, expect, it } from "vitest";
import { amazonStructuredVariant, buildAmazonBackfillUnifyInput, missingAmazonProductLineModifiers } from "./backfill.js";

describe("Amazon legacy backfill planning", () => {
  it("maps legacy label to form and pack to size without inventing dimensions", () => {
    expect(amazonStructuredVariant({ label: "Capsules", pack: "90 Count" })).toEqual({
      form: "capsule",
      size: "90 Count",
    });
  });

  it("keeps unknown legacy evidence in attrsRaw but out of strict variant", () => {
    const input = buildAmazonBackfillUnifyInput({
      productId: "product-1",
      productName: "Example 1000 mg 60 Count",
      companyName: "Example Brand",
      titleRaw: null,
      attrs: { label: "Dietary Supplement", pack: "60 Count", legacy: true },
      productForms: ["Tablets"],
    });
    expect(input).toMatchObject({
      clientRef: "product-1",
      titleRaw: "Example 1000 mg 60 Count",
      brand: "Example Brand",
      structuredVariant: { size: "60 Count" },
      productFormHint: "tablet",
      attrsRaw: { label: "Dietary Supplement", pack: "60 Count", legacy: true },
    });
  });

  it("prefers the original Amazon title and canonicalizes whitespace", () => {
    const input = buildAmazonBackfillUnifyInput({
      productId: "product-2",
      productName: "Fallback",
      companyName: null,
      titleRaw: "  Vitamin C   Gummies  ",
      attrs: null,
      productForms: [],
    });
    expect(input.titleRaw).toBe("Vitamin C Gummies");
    expect(input.brand).toBeNull();
    expect(input.structuredVariant).toEqual({});
  });

  it("flags product-line strength modifiers dropped from baseName", () => {
    expect(missingAmazonProductLineModifiers("Nature Made Extra Strength Magnesium", "Magnesium", null)).toEqual(["extra strength"]);
    expect(missingAmazonProductLineModifiers("Osteo Bi-Flex Triple Strength", "Osteo Bi-Flex Triple Strength", null)).toEqual([]);
    expect(missingAmazonProductLineModifiers("High Potency Astragalus", "Astragalus", "High Potency")).toEqual([]);
  });
});
