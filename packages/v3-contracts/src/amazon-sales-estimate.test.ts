import { describe, expect, it } from "vitest";
import { AMAZON_SALES_CURVE, estimateMonthlyUnits } from "./amazon-sales-estimate.js";

const HH = "Health & Household";

/** Real pages (round-2 holdout 2026-10-20, Best Sellers head set 2026-10-27): rank, and the badge bucket shown. */
const examples = [
  { asin: "B009LI7VRC", rank: 799, bucket: [20_000, 30_000] },
  { asin: "B0GF3SWF4T", rank: 8_599, bucket: [4_000, 5_000] },
  { asin: "B07978NYC5", rank: 8_890, bucket: [3_000, 4_000] },
  { asin: "B0BVJN7CRJ", rank: 16_460, bucket: [1_000, 2_000] },
  { asin: "B0FPCVL9M8", rank: 23_348, bucket: [1_000, 2_000] },
  { asin: "B00GY1D8NK", rank: 149_688, bucket: [50, 100] },
  { asin: "B071K4SDD1", rank: 197_897, bucket: [50, 100] },
];

/** Amazon buckets: 50, 100…900, 1K…9K, 10K…; "within one bucket" is the round-2/3 accuracy definition. */
const buckets = [0, 50, ...[2, 3, 4, 5, 6, 7].flatMap((p) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => i * 10 ** p))];
const bucketIndex = (units: number) => buckets.findIndex((b, i) => units >= b && units < (buckets[i + 1] ?? Infinity));

describe("Amazon BSR → monthly units", () => {
  it.each(AMAZON_SALES_CURVE.nodes)("returns the node value at rank %i", (rank, units) => {
    expect(estimateMonthlyUnits({ category: HH, rank })?.units).toBe(units);
  });

  it.each(examples)("$asin at rank $rank lands within one bucket of $bucket", ({ rank, bucket }) => {
    const estimate = estimateMonthlyUnits({ category: HH, rank });
    expect(estimate).not.toBeNull();
    const [lo] = bucket;
    expect(Math.abs(bucketIndex(estimate!.units) - bucketIndex(lo!))).toBeLessThanOrEqual(1);
    expect(estimate!.range80[0]).toBeLessThanOrEqual(estimate!.units);
    expect(estimate!.range80[1]).toBeGreaterThanOrEqual(estimate!.units);
  });

  it("is monotone in rank and interpolates between nodes", () => {
    let previous = Infinity;
    for (let rank = 100; rank <= 1_000_000; rank = Math.round(rank * 1.3)) {
      const units = estimateMonthlyUnits({ category: HH, rank })!.units;
      expect(units).toBeLessThanOrEqual(previous);
      previous = units;
    }
    const between = estimateMonthlyUnits({ category: HH, rank: 5_000 })!.units;
    expect(between).toBeLessThan(9_552);
    expect(between).toBeGreaterThan(3_010);
  });

  it("clamps ranks above the first node and gives nothing past the last", () => {
    expect(estimateMonthlyUnits({ category: HH, rank: 3 })?.units).toBe(71_319);
    expect(estimateMonthlyUnits({ category: HH, rank: 1_000_001 })).toBeNull();
  });

  it("scales other calibrated categories and declines the rest", () => {
    expect(estimateMonthlyUnits({ category: "Pet Supplies", rank: 10_000 })?.units).toBe(512);
    expect(estimateMonthlyUnits({ category: "Grocery & Gourmet Food", rank: 10_000 })?.units).toBe(1_505);
    expect(estimateMonthlyUnits({ category: "Baby", rank: 10_000 })).toBeNull();
    expect(estimateMonthlyUnits({ category: HH, rank: 0 })).toBeNull();
    expect(estimateMonthlyUnits({ category: HH, rank: 1.5 })).toBeNull();
  });

  it("uses the tighter head band below rank 20,000", () => {
    expect(estimateMonthlyUnits({ category: HH, rank: 10_000 })?.range80).toEqual([1_584, 5_719]);
    expect(estimateMonthlyUnits({ category: HH, rank: 100_000 })?.range80).toEqual([43, 316]);
  });
});
