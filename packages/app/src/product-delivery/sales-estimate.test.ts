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
    expect(result.salesRank).toBe(12_000);
    expect(result.extras["salesEstimate"]).toEqual({
      source: "badge",
      units: 1000,
      rankRead: true,
      rank: 12_000,
      category: "Health & Household",
    });
  });

  it("a badge wins over siblings and over any rank, and keeps the metrics' own period", () => {
    const result = salesEstimateDelivery({
      channel: "amazon",
      metrics: {
        ...metrics({ unitsSold: "50", salesRank: rank(150_000) }),
        unitsSoldPeriod: "unknown",
      },
      siblings: 9,
      extras,
    });
    expect(result).toEqual({
      salesRank: 150_000,
      extras: { ...extras, salesEstimate: expect.objectContaining({ source: "badge", units: 50 }) },
    });
  });

  it("a badge-less variation child is fewer than 50, whatever the family's rank", () => {
    const result = salesEstimateDelivery({
      channel: "amazon",
      // A stale period in the metrics does not survive: the delivered 25 is a trailing-30-day figure.
      metrics: { ...metrics({ salesRank: rank(1_912) }), unitsSoldPeriod: "unknown" },
      siblings: 3,
      extras,
    });
    expect(result).toMatchObject({
      salesRank: 1_912,
      unitsSold: 25,
      unitsSoldPeriod: "trailing_30d",
    });
    expect(result.extras["salesEstimate"]).toEqual({
      source: "variation_child",
      units: 25,
      rankRead: true,
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
    expect(result).toMatchObject({
      salesRank: 10_000,
      unitsSold: 3010,
      unitsSoldPeriod: "trailing_30d",
    });
    expect(result.extras["salesEstimate"]).toMatchObject({
      source: "rank_model",
      rankRead: true,
      units: 3010,
      rank: 10_000,
      estimate: { model: "amazon-bsr-monthly/1", units: 3010, range80: [1584, 5719], factor: 1 },
    });
  });

  it.each([
    {
      name: "rank 20,000 and beyond",
      input: metrics({ salesRank: rank(20_000) }),
      salesRank: 20_000,
      rankRead: true,
    },
    {
      name: "no rank on the page",
      input: metrics({ salesRank: null }),
      salesRank: undefined,
      rankRead: true,
    },
    {
      name: "a capture from before the rank was read",
      input: { price: "9.99", extras: { commerce: { price: "9.99" } } },
      salesRank: undefined,
      rankRead: false,
    },
    {
      name: "a root category without a curve",
      input: metrics({ salesRank: rank(5_000, "Baby") }),
      salesRank: 5_000,
      rankRead: true,
    },
  ])("takes the floor for $name", ({ input, salesRank, rankRead }) => {
    const result = salesEstimateDelivery({
      channel: "amazon",
      metrics: input,
      siblings: 0,
      extras,
    });
    expect(result).toMatchObject({ unitsSold: 25, unitsSoldPeriod: "trailing_30d" });
    expect(result.salesRank).toBe(salesRank);
    expect(result.extras["salesEstimate"]).toMatchObject({ source: "floor", units: 25, rankRead });
  });

  it("a reparse of the retained original overrides the capture's own rank, null meaning none on the page", () => {
    const old = metrics({ salesRank: rank(10_000) });
    const reparsed = salesEstimateDelivery({
      channel: "amazon",
      metrics: { price: "9.99", extras: { commerce: { price: "9.99" } } },
      siblings: 0,
      salesRank: rank(500),
      extras,
    });
    expect(reparsed).toMatchObject({ salesRank: 500, unitsSold: 33_298 });
    expect(reparsed.extras["salesEstimate"]).toMatchObject({
      source: "rank_model",
      rankRead: true,
    });
    const none = salesEstimateDelivery({
      channel: "amazon",
      metrics: old,
      siblings: 0,
      salesRank: null,
      extras,
    });
    expect(none).toMatchObject({ unitsSold: 25 });
    expect(none.salesRank).toBeUndefined();
    expect(none.extras["salesEstimate"]).toEqual({ source: "floor", units: 25, rankRead: true });
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
