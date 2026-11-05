import type { CrossMarketListing, LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceProduct } from "../product-sync/marketplace-model.js";
import { CrossMarketCheck, MATERIAL_WAIT_MS } from "./cross-market-check.js";
import type { CrossMarketRecord } from "./ports.js";
import { sameFormula } from "./same-formula.js";

// KAN-243: illustrative labels shaped like the collected product; NOW Glucosamine B0019LWV92 is a real ASIN sold on
// both amazon.com and amazon.in (the Indian page says it carries the US label).
const signal = new AbortController().signal;
const field = (text: string) => ({ text, sourceId: "src-1" });
function label(rows: [string, string | null][], serving = "3 Capsules"): LabelCollectedProduct {
  return {
    operationId: `collected-${rows.length}-${serving}`,
    formula: {
      servingSize: field(serving),
      servingsPerContainer: null,
      columns: [
        {
          heading: null,
          rows: rows.map(([name, amount]) => ({
            kind: "ingredient",
            name: field(name),
            amount: amount ? field(amount) : null,
            dailyValue: null,
            purpose: null,
            amountStatus: amount ? "printed" : "not_declared",
            parentRowIndex: null,
          })),
        },
      ],
    },
    otherIngredients: null,
  } as unknown as LabelCollectedProduct;
}
const US_ROWS: [string, string][] = [
  ["Glucosamine Sulfate", "1,500 mg"],
  ["Chondroitin Sulfate", "1,200 mg"],
];
function product(channel: "amazon" | "amazon-in", collection: LabelCollectedProduct | null) {
  return {
    channel,
    listingId: "B0019LWV92",
    variantId: null,
    brandId: "brand-now",
    brand: "NOW Foods",
    product: { title: "NOW Glucosamine & Chondroitin", brandRaw: "NOW Foods" },
    collection,
  } as unknown as MarketplaceProduct;
}
const US_LISTING = { listingId: "us-listing", countryCode: "US" } as CrossMarketListing;

function check(options: {
  listings?: CrossMarketListing[];
  other?: MarketplaceProduct | null;
  prior?: CrossMarketRecord | null;
  recapture?: "queued" | "already-queued" | "no-source";
  now?: Date;
}) {
  const records: CrossMarketRecord[] = [];
  const deps = {
    listings: {
      lookup: vi.fn(async () => new Map([["B0019LWV92", options.listings ?? [US_LISTING]]])),
    },
    material: { read: vi.fn(async () => (options.other ? [options.other] : [])) },
    judge: {
      judge: vi.fn(async () => ({
        verdict: "different" as const,
        reasons: ["local_formulation"],
        model: "gpt-x/high",
      })),
    },
    records: {
      latest: vi.fn(async () => options.prior ?? null),
      record: vi.fn(async (entry: CrossMarketRecord) => void records.push(entry)),
    },
    recapture: { request: vi.fn(async () => options.recapture ?? "queued") },
    now: () => options.now ?? new Date("2026-11-05T12:00:00.000Z"),
  };
  return { service: new CrossMarketCheck(deps), deps, records };
}

describe("cross-market check", () => {
  it("says same by rule when both labels print the same rows and serving, never asking the model", async () => {
    const india = product(
      "amazon-in",
      label([
        ["glucosamine sulfate", "1,500 mg"],
        ["Chondroitin  Sulfate*", "1,200 mg"],
      ]),
    );
    const { service, deps, records } = check({ other: product("amazon", label(US_ROWS)) });
    const outcome = (await service.outcomes([india], signal)).get(india);
    expect(outcome).toEqual({
      field: {
        verdict: "same",
        comparedWith: { listingId: "us-listing", countryCode: "US", externalId: "B0019LWV92" },
        method: "rule",
        reasons: ["same_rows_and_serving"],
        decidedAt: "2026-11-05T12:00:00.000Z",
      },
    });
    expect(deps.judge.judge).not.toHaveBeenCalled();
    expect(deps.material.read).toHaveBeenCalledWith("amazon", ["B0019LWV92"], signal);
    expect(records).toMatchObject([{ status: "decided", comparedListingId: "us-listing" }]);
  });

  it("asks the label model when the labels differ, and sends its verdict with the model named", async () => {
    const india = product("amazon-in", label([["Glucosamine Sulfate", "750 mg"]], "1 Tablet"));
    const { service, deps } = check({ other: product("amazon", label(US_ROWS)) });
    const outcome = (await service.outcomes([india], signal)).get(india);
    expect(outcome).toMatchObject({
      field: { verdict: "different", method: "codex", model: "gpt-x/high" },
    });
    expect(deps.judge.judge).toHaveBeenCalledWith(
      expect.objectContaining({
        listing: expect.objectContaining({ marketplace: "amazon.in", servingSize: "1 Tablet" }),
        other: expect.objectContaining({ marketplace: "amazon.com", rows: expect.any(Array) }),
      }),
      signal,
    );
  });

  it("queues the other storefront's page once and holds the listing; later rounds wait without recording again", async () => {
    const india = product("amazon-in", label(US_ROWS));
    const first = check({ other: null });
    expect((await first.service.outcomes([india], signal)).get(india)).toEqual({
      hold: "material",
    });
    expect(first.deps.recapture.request).toHaveBeenCalledWith(
      { channel: "amazon", listingId: "B0019LWV92", brandId: "brand-now" },
      signal,
    );
    expect(first.records).toMatchObject([{ status: "pending" }]);
    const pending = { ...first.records[0], status: "pending" } as CrossMarketRecord;
    const later = check({ other: null, prior: pending, recapture: "already-queued" });
    expect((await later.service.outcomes([india], signal)).get(india)).toEqual({
      hold: "material",
    });
    expect(later.records).toEqual([]);
  });

  it("sends no verdict, keeping why, when the page cannot be queued or never arrives", async () => {
    const india = product("amazon-in", label(US_ROWS));
    const noSource = check({ other: null, recapture: "no-source" });
    expect((await noSource.service.outcomes([india], signal)).get(india)).toEqual({ none: true });
    expect(noSource.records).toMatchObject([{ status: "unjudged", reason: "no_crawler_material" }]);
    const pending = {
      channel: "amazon-in",
      listingId: "B0019LWV92",
      collectionOperationId: "x",
      comparedListingId: "us-listing",
      status: "pending",
      recordedAt: "2026-11-01T00:00:00.000Z",
    } as CrossMarketRecord;
    const late = check({
      other: null,
      prior: pending,
      now: new Date(Date.parse(pending.recordedAt) + MATERIAL_WAIT_MS + 1),
    });
    expect((await late.service.outcomes([india], signal)).get(india)).toEqual({ none: true });
    expect(late.records).toMatchObject([
      { status: "unjudged", reason: "other_material_unavailable" },
    ]);
    expect(late.deps.recapture.request).not.toHaveBeenCalled();
  });

  it("reuses a decided verdict, and sends nothing when no other storefront lists the ASIN", async () => {
    const india = product("amazon-in", label(US_ROWS));
    const decided = check({
      prior: { status: "decided", field: { verdict: "same" } } as unknown as CrossMarketRecord,
    });
    expect((await decided.service.outcomes([india], signal)).get(india)).toEqual({
      field: { verdict: "same" },
    });
    expect(decided.deps.material.read).not.toHaveBeenCalled();
    const alone = check({
      listings: [{ listingId: "in-listing", countryCode: "IN" } as CrossMarketListing],
    });
    expect((await alone.service.outcomes([india], signal)).get(india)).toEqual({ none: true });
    expect(alone.records).toEqual([]);
  });

  it("holds only the listing whose judgment failed, recording nothing, so the next round judges it again", async () => {
    const india = product("amazon-in", label([["Glucosamine Sulfate", "750 mg"]], "1 Tablet"));
    const failing = check({ other: product("amazon", label(US_ROWS)) });
    failing.deps.judge.judge.mockRejectedValueOnce(new Error("codex turn failed"));
    expect((await failing.service.outcomes([india], signal)).get(india)).toEqual({
      hold: "judgment",
    });
    expect(failing.records).toEqual([]);
  });

  it("never calls a missing serving, an undosed label or a different row the same", () => {
    expect(sameFormula(label(US_ROWS), label(US_ROWS))).toBe(true);
    expect(sameFormula(label(US_ROWS), label(US_ROWS, "2 Capsules"))).toBe(false);
    expect(
      sameFormula(label([["Glucosamine Sulfate", null]]), label([["Glucosamine Sulfate", null]])),
    ).toBe(false);
    expect(sameFormula(label(US_ROWS), label([...US_ROWS, ["MSM", "500 mg"]]))).toBe(false);
  });
});
