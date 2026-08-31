import { describe, expect, it } from "vitest";
import { BRAND_STORE_SCRIPT, explicitAmazonTitleForm, parseImageIngredientOutput, verifiedAmazonBrand } from "./pipeline.js";

describe("Amazon Brand Store discovery", () => {
  it("keeps the scroll, ASIN, navigation, and challenge probe executable", () => {
    expect(() => new Function(`return ${BRAND_STORE_SCRIPT}`)).not.toThrow();
    expect(BRAND_STORE_SCRIPT).toContain("data-asin");
    expect(BRAND_STORE_SCRIPT).toContain("storeLinks");
    expect(BRAND_STORE_SCRIPT).toContain("hasAllProductsSignal");
    expect(BRAND_STORE_SCRIPT).toContain("validateCaptcha");
  });

  it("uses manufacturer only when the title independently confirms it", () => {
    expect(verifiedAmazonBrand({
      title: "Ancient Nutrition Grass-Fed Liver Tablets",
      brand: null,
      manufacturer: "Ancient Nutrition",
    })).toBe("Ancient Nutrition");
    expect(verifiedAmazonBrand({
      title: "Grass-Fed Liver Tablets",
      brand: null,
      manufacturer: "Unknown Seller",
    })).toBeNull();
  });

  it("prefers dosage forms stated explicitly in the product title", () => {
    expect(explicitAmazonTitleForm("Ancient Nutrition Organic Supergreens Gummy, Strawberry Watermelon")).toBe("gummy");
    expect(explicitAmazonTitleForm("SBO Probiotics 60 Capsules")).toBe("capsule");
    expect(explicitAmazonTitleForm("Ancient Nutrition Daily Wellness Formula")).toBeUndefined();
  });

  it("extracts only named OCR ingredient rows from the model payload", () => {
    expect(parseImageIngredientOutput('prefix [{"name":"Grass-Fed Liver"},{"name":"Heart"},{"name":"Grass-Fed Liver"}]')).toEqual([
      "Grass-Fed Liver",
      "Heart",
    ]);
    expect(parseImageIngredientOutput("[]")).toEqual([]);
  });
});
