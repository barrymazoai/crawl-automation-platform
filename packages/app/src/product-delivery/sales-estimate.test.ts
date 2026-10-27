import { describe, expect, it } from "vitest";
import { labelExtras } from "./listing-date.js";
import { salesEstimateDelivery } from "./sales-estimate.js";

const rank = (rank: number, category = "Health & Household") => ({
  rank,
  category,
  rawText: `#${rank} in ${category} (See Top 100 in ${category})`,
  selector: "#detailBullets_feature_div li" as const,
});
const metrics = (input: {
  unitsSold?: string | null;
  salesRank?: ReturnType<typeof rank> | null;
}) => ({
  price: "9.99",
  unitsSold: input.unitsSold ?? null,
  unitsSoldPeriod: input.unitsSold ? "trailing_30d" : null,
  salesRank: input.salesRank ? String(input.salesRank.rank) : null,
  extras: { commerce: { price: "9.99", salesRank: input.salesRank ?? null } },
});
const extras = { commerce: { price: "9.99" } };

describe("Amazon monthly units (owner 2026-10-27)", () => {
  it("keeps the page badge and records it as the source", () => {
    const result = salesEstimateDelivery({
      channel: "amazon",
      metrics: metrics({ unitsSold: "1000", salesRank: rank(12_000) }),
      siblings: 4,
      extras,
    });
    expect(result.unitsSold).toBeUndefined();
    expect(result.extras["salesEstimate"]).toEqual({
      source: "badge",
      units: 1000,
      rank: 12_000,
      category: "Health & Household",
    });
  });

  it("a badge-less variation child is fewer than 50, whatever the family's rank", () => {
    const result = salesEstimateDelivery({
      channel: "amazon",
      metrics: metrics({ salesRank: rank(1_912) }),
      siblings: 3,
      extras,
    });
    expect(result).toMatchObject({ unitsSold: 25, unitsSoldPeriod: "trailing_30d" });
    expect(result.extras["salesEstimate"]).toEqual({
      source: "variation_child",
      units: 25,
      rank: 1_912,
      category: "Health & Household",
    });
  });

  it("a badge-less single SKU ranked below 20,000 takes the curve, with its range", () => {
    const result = salesEstimateDelivery({
      channel: "amazon",
      metrics: metrics({ salesRank: rank(10_000) }),
      siblings: 0,
      extras,
    });
    expect(result).toMatchObject({ unitsSold: 3010, unitsSoldPeriod: "trailing_30d" });
    expect(result.extras["salesEstimate"]).toMatchObject({
      source: "rank_model",
      units: 3010,
      rank: 10_000,
      estimate: { model: "amazon-bsr-monthly/1", units: 3010, range80: [1584, 5719], factor: 1 },
    });
  });

  it.each([
    ["rank 20,000 and beyond", metrics({ salesRank: rank(20_000) })],
    ["no rank on the page", metrics({ salesRank: null })],
    [
      "a capture from before the rank was read",
      { price: "9.99", extras: { commerce: { price: "9.99" } } },
    ],
    ["a root category without a curve", metrics({ salesRank: rank(5_000, "Baby") })],
  ])("takes the floor for %s", (_name, input) => {
    const result = salesEstimateDelivery({
      channel: "amazon",
      metrics: input,
      siblings: 0,
      extras,
    });
    expect(result).toMatchObject({ unitsSold: 25, unitsSoldPeriod: "trailing_30d" });
    expect(result.extras["salesEstimate"]).toMatchObject({ source: "floor", units: 25 });
  });

  it("leaves other channels untouched", () => {
    const result = salesEstimateDelivery({
      channel: "gnc",
      metrics: metrics({ salesRank: null }),
      siblings: 0,
      extras,
    });
    expect(result).toEqual({ extras });
  });

  it("never reaches a label request body", () => {
    const withEstimate = {
      commerce: { price: "9.99", salesRank: rank(10_000), dateFirstAvailable: null },
      salesEstimate: { source: "rank_model", units: 3010 },
      crawler: { sourceId: "s" },
    };
    expect(labelExtras("amazon", withEstimate)).toEqual({
      commerce: { price: "9.99" },
      crawler: { sourceId: "s" },
    });
    expect(labelExtras("amazon", { commerce: { price: "9.99" } })).toEqual({
      commerce: { price: "9.99" },
    });
  });
});
