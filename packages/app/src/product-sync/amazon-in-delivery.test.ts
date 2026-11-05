import { describe, expect, it, vi } from "vitest";
import { listingStateBatches } from "../listings/listing-delivery.js";
import type { ListingObservation } from "../listings/listing-model.js";
import type { ListingStateBatch } from "../listings/ports.js";
import { MarketplaceRoutedListingStates } from "../listings/routed-sender.js";
import { labelListing } from "../product-delivery/listing-date.js";
import type { ProductObservationWriter } from "../product-delivery/ports.js";
import { salesEstimateDelivery } from "../product-delivery/sales-estimate.js";
import type { BrandCompanyMatch } from "./brand-company-model.js";
import type { MarketplaceProduct } from "./marketplace-model.js";
import { ProductSyncService } from "./sync-service.js";
import { partialRun } from "./sync-send.js";

// KAN-243: amazon.in goes to Supply Smart as channel `amazon` with marketplace `amazon.in`; every US body is unchanged.
const signal = new AbortController().signal;
const planned = (channel: string) =>
  [
    {
      product: { channel },
      item: { externalId: "B0BL3TN1QC", capturedAt: "2026-11-04T12:07:41Z" },
    },
  ] as unknown as Parameters<typeof partialRun>[0]["planned"];

describe("amazon.in delivery", () => {
  it("runs as Supply Smart's amazon channel naming amazon.in; a US run names no marketplace", () => {
    expect(partialRun({ runId: "run", planned: planned("amazon-in") })).toMatchObject({
      channel: "amazon",
      marketplace: "amazon.in",
    });
    expect(partialRun({ runId: "run", planned: planned("amazon") })).not.toHaveProperty(
      "marketplace",
    );
  });

  it("sends listing states per storefront, each Indian item naming amazon.in", () => {
    const sighting = (channel: ListingObservation["channel"]): ListingObservation => ({
      observationId: `${channel}-sighting`,
      channel,
      listingId: "B0BL3TN1QC",
      variantId: null,
      brandId: null,
      runId: null,
      state: "unlisted",
      reason: "not_found",
      source: "product-run",
      capturedAt: "2026-11-05T00:00:00.000Z",
      registeredAt: "2026-11-05T00:00:00.000Z",
      deliveredAt: null,
      evidence: {
        probe: "direct-revisit",
        causeCode: "LISTING.NOT_FOUND",
        httpStatus: 404,
        observedExternalId: null,
        finalUrl: null,
        artifactKey: null,
      },
    });
    const [us, india] = listingStateBatches(
      [sighting("amazon"), sighting("amazon-in")],
      new Map(),
      "2026-11-05T00:00:00.000Z",
    );
    expect(us?.batch.run).not.toHaveProperty("marketplace");
    expect(us?.batch.items[0]?.listing).toEqual({ channel: "amazon", externalId: "B0BL3TN1QC" });
    expect(india?.batch.run).toMatchObject({ channel: "amazon", marketplace: "amazon.in" });
    expect(india?.batch.items[0]?.listing).toEqual({
      channel: "amazon",
      marketplace: "amazon.in",
      externalId: "B0BL3TN1QC",
    });
  });

  it("routes listing states by marketplace and refuses a storefront without a target", async () => {
    const production = { send: vi.fn(async () => []) };
    const test = { send: vi.fn(async () => []) };
    const sender = new MarketplaceRoutedListingStates(production, new Map([["amazon.in", test]]));
    const batch = (marketplace?: string) =>
      ({
        run: { runId: "r", channel: "amazon", ...(marketplace ? { marketplace } : {}) },
        items: [],
      }) as unknown as ListingStateBatch;
    await sender.send(batch(), signal);
    await sender.send(batch("amazon.in"), signal);
    expect(production.send).toHaveBeenCalledTimes(1);
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(() => sender.send(batch("amazon.co.uk"), signal)).toThrow(/No Supply Smart target/u);
  });

  it("sends the Indian page badge as printed and never the US units curve or floor", () => {
    const rank = {
      rank: 293,
      category: "Health & Personal Care",
      rawText: "#293 in Health & Personal Care",
      selector: "#detailBullets_feature_div li" as const,
    };
    const metrics = { extras: { commerce: { salesRank: rank } } };
    expect(
      salesEstimateDelivery({ channel: "amazon-in", metrics, siblings: 0, extras: {} }),
    ).toEqual({ salesRank: 293, extras: {} });
    expect(
      salesEstimateDelivery({ channel: "amazon", metrics, siblings: 0, extras: {} }),
    ).toMatchObject({ unitsSold: 25, extras: { salesEstimate: { source: "floor" } } });
  });

  it("keeps the rank and Amazon-only extras out of an Indian label body, like amazon.com's", () => {
    const listing = { salesRank: 293, unitsSold: 10_000, extras: { amazonDfa: {} } };
    expect(labelListing("amazon-in", listing)).toEqual({ unitsSold: 10_000, extras: {} });
  });
});

describe("amazon.in's own Supply Smart target", () => {
  const brandId = "11111111-1111-4111-8111-111111111111";
  const production: BrandCompanyMatch = {
    brandId,
    status: "matched",
    companyId: "22222222-2222-4222-8222-222222222222",
    domain: "kapiva.in",
    matchedBy: "website",
    candidates: [],
    checkedAt: "2026-11-05T00:00:00.000Z",
  };
  const product = { channel: "amazon-in", listingId: "B0BL3TN1QC", variantId: null, brandId };
  const writer = () =>
    ({
      ingest: vi.fn(),
      readLabel: vi.fn(),
      verify: vi.fn(),
      complete: vi.fn(),
    }) as unknown as ProductObservationWriter & {
      ingest: ReturnType<typeof vi.fn>;
    };

  function service(resolution: { status: "matched" | "unmatched"; companyId: string | null }) {
    const target = {
      writer: writer(),
      companies: {
        resolveDomain: vi.fn(async () => ({
          ...resolution,
          companyName: null,
          candidates: [],
          reason: "",
        })),
      },
    };
    const fallback = writer();
    const sync = new ProductSyncService({
      reader: {
        read: async () =>
          ({ products: [product as unknown as MarketplaceProduct], next: null }) as never,
      },
      brands: { matches: async () => [production] },
      ledger: {
        read: async () => [],
        record: async () => undefined,
        touch: async () => undefined,
      } as never,
      writer: fallback,
      writers: { "amazon-in": target },
    });
    return { sync, target, fallback };
  }

  it("resolves the brand's company by domain in that database; a domain it does not know waits, nothing is sent", async () => {
    const { sync, target, fallback } = service({ status: "unmatched", companyId: null });
    const result = await sync.sync({ channel: "amazon-in", limit: 10 } as never, signal);
    expect(target.companies.resolveDomain).toHaveBeenCalledWith("kapiva.in", signal);
    expect(result.waitingCompany).toBe(1);
    expect(target.writer.ingest).not.toHaveBeenCalled();
    expect(fallback.ingest).not.toHaveBeenCalled();
  });
});

describe("cross-market verdicts in a batch", () => {
  it("leaves a listing waiting for material out of the batch and puts a verdict on the item only", async () => {
    const { withOutcomes } = await import("./sync-service.js");
    const entry = (listingId: string) =>
      ({
        product: { listingId },
        item: { externalId: listingId },
        label: { listing: { externalId: listingId } },
      }) as unknown as Parameters<typeof withOutcomes>[0][number];
    const [waiting, judged, alone] = [entry("A"), entry("B"), entry("C")];
    const field = { verdict: "same" } as never;
    const tally = { result: {} } as never as Parameters<typeof withOutcomes>[2];
    const ready = withOutcomes(
      [waiting, judged, alone],
      new Map<unknown, unknown>([
        [waiting.product, { hold: "material" }],
        [judged.product, { field }],
        [alone.product, { none: true }],
      ]) as never,
      tally,
    );
    expect(ready.map((sent) => sent.item.externalId)).toEqual(["B", "C"]);
    expect(ready[0]?.item).toEqual({ externalId: "B", crossMarket: field });
    expect(ready[0]?.label).toEqual({ listing: { externalId: "B" } });
    expect(ready[1]?.item).not.toHaveProperty("crossMarket");
    expect(tally.result.waitingCrossMarket).toBe(1);
  });
});
