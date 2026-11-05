import { describe, expect, it } from "vitest";
import { crossMarketPrompt } from "./cross-market-judge.js";

const side = (marketplace: string, amount: string) => ({
  marketplace,
  title: "NOW Glucosamine & Chondroitin",
  brand: "NOW Foods",
  servingSize: "3 Capsules",
  servingsPerContainer: null,
  rows: [{ name: "Glucosamine Sulfate", amount, dailyValue: null }],
  otherIngredients: null,
});

describe("cross-market judgment prompt (KAN-243)", () => {
  it("names both storefronts, gives both labels as printed, and asks for unsure rather than a guess", () => {
    const prompt = crossMarketPrompt({
      listing: side("amazon.in", "750 mg"),
      other: side("amazon.com", "1,500 mg"),
    });
    expect(prompt).toContain("Listing (amazon.in):");
    expect(prompt).toContain("Other storefront (amazon.com):");
    expect(prompt).toContain('"amount":"750 mg"');
    expect(prompt).toContain('"amount":"1,500 mg"');
    expect(prompt).toContain("Never guess.");
  });
});
