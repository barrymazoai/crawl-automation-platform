import type { CapturedPage } from "@crawl-automation/channels-core";
import { describe, expect, it, vi } from "vitest";
import { canonicalHash } from "./canonical.js";
import { captureHistoryEntry } from "./capture-history.js";
import { commerceMetrics } from "./commerce-metrics.js";
import { identifyListing, type ListingIdentityResolver } from "./listing-identity.js";
import { MetricsHistory } from "./metrics-history.js";
import type { HistoryEntry, ProductHistoryStore } from "./ports.js";

// IDs the earlier history store (apps/v3-api/src/history/model.ts) computes for the same pages.
const OLD_IDS = {
  gnc: "7237a9b049a13cf122b51f72ae2cdb2c46b26baab8d1f7d004300860f37ad03c",
  swanson: "2addecc924b260559feb5268680a9a141e2a83dea24fafa5ea4db0276eb4d425",
  amazon: "b66b276da1240eb5080278c3b8870d8e580914ec0b0d06562f1475a67cafb183",
};

const at = { dataset: "v3:test", sourceKey: "k" };

// The port has already validated these addresses; adapter validation is covered in worker tests.
const identities: ListingIdentityResolver = {
  resolve: vi.fn((page) => {
    if (page.url.startsWith("https://example.com") || page.listingId === "B000000000") {
      return null;
    }
    const url = new URL(page.url);
    url.hostname = url.hostname.replace(/^www\./u, "");
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/u, "");
    return { site: url.hostname, url: url.href, externalId: page.externalId ?? page.listingId };
  }),
};

function page(changes: Partial<CapturedPage> = {}): CapturedPage {
  return {
    channel: "gnc",
    url: "https://www.gnc.com/energy/877080.html",
    listingId: "877080",
    variantId: null,
    externalId: "877080",
    capturedAt: "2026-09-30T01:02:03.000Z",
    commerce: {
      codec: "public-product-commerce/1",
      sku: "877080",
      price: "29.99",
      currency: "USD",
      listPrice: null,
      rating: "4.6",
      reviewCount: "118",
      availability: "instock",
      context: [],
      priceStatus: "observed",
    },
    archive: { objectKey: "v3/gnc-html/op-1/original.html", sha256: "a".repeat(64) },
    ...changes,
  };
}

const run = { runId: "run-1", operationId: "op-1", brandId: "brand-1", sourceId: "source-1" };

describe("history listing identity", () => {
  it("keys listings exactly as the earlier history store did", () => {
    const gnc = {
      channel: "gnc",
      url: "https://www.gnc.com/energy/877080.html",
      externalId: "877080",
      listingId: "877080",
    };
    const swanson = {
      channel: "swanson",
      url: "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr?utm_source=x",
      externalId: "HOR083",
      listingId: "healthy-origins-natural-d-ribose-10-6-oz-pwdr",
    };
    const amazon = {
      channel: "amazon",
      url: "https://www.amazon.com/dp/B002CQU54Q/?th=1",
      externalId: "B002CQU54Q",
      listingId: "B002CQU54Q",
    };
    expect(identifyListing({ ...gnc, ...at }, identities).id).toBe(OLD_IDS.gnc);
    expect(identifyListing({ ...swanson, ...at }, identities).id).toBe(OLD_IDS.swanson);
    expect(identifyListing({ ...amazon, ...at }, identities)).toMatchObject({
      id: OLD_IDS.amazon,
      externalId: "B002CQU54Q",
      url: "https://amazon.com/dp/B002CQU54Q",
    });
    expect(canonicalHash({ b: 1, a: [2, { d: 3, c: null }] })).toBe(
      "05d056f52fa44429fb2c28612f0ecc637c2b5c9515c394aa667f7712c0bdcb42",
    );
  });

  it("keys a Whole Foods listing by its ASIN on the Whole Foods site", () => {
    const listing = identifyListing(
      {
        channel: "wholefoods",
        url: "https://www.wholefoodsmarket.com/grocery/product/nordic-naturals-b002cqu54q",
        externalId: "B002CQU54Q",
        listingId: "B002CQU54Q",
        ...at,
      },
      identities,
    );
    expect(listing).toMatchObject({ basis: "external-id", site: "wholefoodsmarket.com" });
  });

  it("an ASIN that contradicts the Amazon URL is never a keyed listing", () => {
    const listing = identifyListing(
      {
        channel: "amazon",
        url: "https://www.amazon.com/dp/B002CQU54Q",
        externalId: "B000000000",
        listingId: "B000000000",
        ...at,
      },
      identities,
    );
    expect(listing.basis).toBe("unresolved");
  });
});

describe("commerce metrics", () => {
  it("reads a page's commerce as the earlier projection did", () => {
    const raw = {
      price: "$1,234.50",
      currency: "usd",
      rating: "4.5 out of 5 stars",
      reviewCount: "(1,234)",
      availability: "In stock",
    };
    expect(commerceMetrics(raw)).toEqual({
      price: "1234.50",
      currency: "USD",
      listPrice: null,
      rating: "4.5",
      reviewCount: "1234",
      salesRank: null,
      inStock: true,
      unitsSold: null,
      unitsSoldPeriod: null,
      extras: { commerce: raw },
    });
  });

  it("keeps the store a Whole Foods price belongs to, and reads its availability words", () => {
    const metrics = commerceMetrics({
      price: "45.04",
      availability: "unavailable",
      context: ["wholefoods-store:10259", "wholefoods-store-label:The Alameda"],
    });
    expect(metrics.extras?.["store"]).toEqual({ id: "10259", label: "The Alameda" });
    expect(metrics.inStock).toBe(false);
    expect(commerceMetrics({ availability: "available" }).inStock).toBe(true);
  });

  it("a value the page does not show stays null", () => {
    expect(commerceMetrics(null)).toMatchObject({ price: null, rating: null, inStock: null });
  });
});

describe("capture history entry", () => {
  it("is one metrics point per product operation, stable when recorded again", () => {
    const first = captureHistoryEntry(page(), run, identities);
    expect(first).toMatchObject({ dataset: "v3:gnc", sourceKey: "op-1", issues: [] });
    expect(first.listings[0]?.id).toBe(OLD_IDS.gnc);
    expect(first.observations[0]).toMatchObject({
      kind: "metrics",
      observedAt: "2026-09-30T01:02:03.000Z",
      record: { price: "29.99", rating: "4.6", reviewCount: "118", source: "v3:gnc" },
    });
    expect(captureHistoryEntry(page(), run, identities)).toEqual(first);
    const next = captureHistoryEntry(page(), { ...run, operationId: "op-2" }, identities);
    expect(next.id).not.toBe(first.id);
    expect(next.listings[0]?.id).toBe(first.listings[0]?.id);
  });

  it("a page naming no keyable listing is refused", () => {
    const foreign = page({ url: "https://example.com/p/1" });
    expect(() => captureHistoryEntry(foreign, run, identities)).toThrow(
      expect.objectContaining({ code: "HISTORY.CAPTURE_IDENTITY_UNRESOLVED" }),
    );
  });
});

describe("metrics history", () => {
  it("appends the capture's entry and reports its listing and point", async () => {
    const appended: HistoryEntry[] = [];
    const store: ProductHistoryStore = {
      append: async (entry) => {
        appended.push(entry);
        return { inserted: appended.length === 1 };
      },
    };
    const history = new MetricsHistory(store, identities);
    const first = await history.record(page(), run);
    expect(first).toMatchObject({ inserted: true, historyListingId: OLD_IDS.gnc });
    expect((await history.record(page(), run)).inserted).toBe(false);
    expect(appended[0]).toEqual(appended[1]);
  });
});
