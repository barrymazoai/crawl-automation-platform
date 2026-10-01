import { describe, expect, it } from "vitest";
import { commerceMetrics } from "./commerce-metrics.js";

describe("commerce stock history", () => {
  it.each([
    true,
    "InStock",
    "in_stock",
    "In stock.",
    "available",
    "Only 2 left in stock - order soon.",
    "https://schema.org/InStock",
    "LimitedAvailability",
    "OnlineOnly",
    "InStoreOnly",
  ])("accepts available state %s", (availability) => {
    expect(commerceMetrics({ availability }).inStock).toBe(true);
  });
  it.each([
    false,
    "OutOfStock",
    "out_of_stock",
    "SoldOut",
    "sold_out",
    "unavailable",
    "Discontinued",
    "Out of stock",
    "https://schema.org/OutOfStock",
    "Currently unavailable.",
  ])("accepts unavailable state %s", (availability) => {
    expect(commerceMetrics({ availability }).inStock).toBe(false);
  });
  it.each([
    null,
    undefined,
    "unknown",
    "PreOrder",
    "PreSale",
    "BackOrder",
    "https://schema.org/PreOrder",
  ])("keeps unverified stock %s unknown", (availability) => {
    expect(commerceMetrics({ availability }).inStock).toBeNull();
  });
  it("retains sales qualifiers and purchase terms without inventing sales rank", () => {
    const salesVolume = { lowerBound: "1000", period: "past_month", approximate: true };
    const purchaseConditions = { promotions: [{ description: "Save 10% coupon" }] };
    expect(commerceMetrics({ salesVolume, purchaseConditions })).toMatchObject({
      unitsSold: "1000",
      unitsSoldPeriod: "trailing_30d",
      salesRank: null,
      extras: { salesVolume, purchaseConditions },
    });
  });
});
