import { describe, expect, it, vi } from "vitest";
import type { ProductObservationWriter } from "../product-delivery/ports.js";
import type { BrandCompanyMatch } from "./brand-company-model.js";
import type { ProductSyncLedger, SyncChange, SyncKey, SyncRecord } from "./ledger.js";
import type { MarketplaceProduct, MarketplaceReadRequest } from "./marketplace-model.js";
import {
  marketplaceSamples,
  marketplaceSamplesPath,
  required,
} from "./marketplace-samples.fixture.js";
import { ProductSyncService } from "./sync-service.js";

const signal = () => new AbortController().signal;
const brandId = "11111111-1111-4111-8111-111111111111";
// Real GNC samples (PMD 967060, GNC 424743, Peptiva 452410) with an explicit crawler brand.
const products = (ids = ["967060", "424743"]): MarketplaceProduct[] =>
  ids.map((id) => ({
    ...structuredClone(required(marketplaceSamples().find((entry) => entry.listingId === id))),
    brandId,
  }));
const matched: BrandCompanyMatch = {
  brandId,
  status: "matched",
  companyId: "22222222-2222-4222-8222-222222222222",
  domain: "gnc.com",
  matchedBy: "name",
  candidates: [],
  checkedAt: "2026-10-12T00:00:00.000Z",
};

function memoryLedger(): ProductSyncLedger & { rows: Map<string, SyncRecord> } {
  const rows = new Map<string, SyncRecord>();
  const key = (entry: SyncKey) => `${entry.channel}|${entry.listingId}|${entry.variantId ?? ""}`;
  return {
    rows,
    read: async (keys) => keys.flatMap((entry) => rows.get(key(entry)) ?? []),
    record: async (changes: SyncChange[]) => {
      for (const change of changes) {
        const prior = rows.get(key(change));
        rows.set(key(change), {
          collectedOperationId: null,
          payloadHash: null,
          ingestRunId: null,
          supplySmartProductId: null,
          supplySmartListingId: null,
          error: null,
          ...prior,
          ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
          attempts: (prior?.attempts ?? 0) + (change.status === "sent" ? 1 : 0),
          updatedAt: "2026-10-12T00:00:00.000Z",
        } as SyncRecord);
      }
    },
    touch: async () => undefined,
    markPresent: async () => ({ marked: 0, skipped: 0 }),
    counts: async () => [],
    overview: async () => [],
    reopen: async () => ({ reopened: 0 }),
    markRemoved: async () => undefined,
    notSupplementsDelivered: async () => [],
  };
}

/** A Supply Smart stand-in answering like the v2 ingest, label and verify procedures. */
function supplySmart(
  options: { failRef?: (ref: string) => boolean; reviewRef?: (ref: string) => boolean } = {},
) {
  const review = (ref: string) => options.reviewRef?.(ref) ?? false;
  const observations = new Map<string, string>();
  const writer = {
    ingest: vi.fn(async ({ run, items }) => ({
      runId: run.runId,
      crawlRunId: "crawl-run",
      counts: {
        received: items.length,
        ok: items.length,
        failed: 0,
        created: 0,
        matched: 0,
        needsReview: 0,
      },
      results: items.map((item: { clientRef: string }) =>
        options.failRef?.(item.clientRef)
          ? {
              clientRef: item.clientRef,
              status: "failed",
              error: { code: "company_not_found", message: "no company" },
            }
          : {
              clientRef: item.clientRef,
              status: "ok",
              observationSkipped: null,
              identity: { state: review(item.clientRef) ? "needs_review" : "matched" },
              error: null,
            },
      ),
    })),
    label: vi.fn(async (label) => {
      observations.set(label.submitter.operationId, label.observation.observationId);
      return {
        outcome: "created",
        operationId: label.submitter.operationId,
        requestFingerprint: "fp",
        labelObservationId: "obs-1",
        labelHash: "hash-1",
        steps: { labelObservation: "done" },
        error: null,
      };
    }),
    readLabel: vi.fn(async ({ operationId, submitterNamespace }) => ({
      found: true,
      request: { state: "completed" },
      observation: {
        id: "obs-1",
        operationId,
        submitterNamespace,
        externalObservationId: observations.get(operationId),
      },
      matches: { labelHash: true, requestFingerprint: true },
      problems: [],
    })),
    verify: vi.fn(async ({ runId, clientRefs }) => ({
      runId,
      found: true,
      // Like Supply Smart: an item in identity review is not counted as verified.
      verified: clientRefs.filter((ref: string) => !review(ref)).length,
      expected: clientRefs.length,
      problems: ["run_not_completed"],
      readbackHash: "x",
      items: clientRefs.map((clientRef: string) => ({
        clientRef,
        recorded: true,
        ledger: { status: "ok" },
        product: {
          id: `product-${clientRef}`,
          identityState: review(clientRef) ? "needs_review" : "resolved",
        },
        listing: { id: `listing-${clientRef}` },
        mismatches: [],
        problems: [],
      })),
    })),
    complete: vi.fn(async ({ runId }) => ({
      runId,
      found: true,
      replayed: false,
      scope: "partial",
      status: "completed",
      deactivated: 0,
      deactivatedListingIds: [],
      problems: [],
    })),
  };
  return writer as unknown as ProductObservationWriter & typeof writer;
}

function setup(
  input: {
    match?: BrandCompanyMatch | null;
    writer?: ReturnType<typeof supplySmart>;
    ids?: string[];
    products?: MarketplaceProduct[];
  } = {},
) {
  const ledger = memoryLedger();
  const writer = input.writer ?? supplySmart();
  const page = input.products ?? products(input.ids);
  const reader = {
    read: vi.fn(async (_request: MarketplaceReadRequest) => ({
      products: structuredClone(page),
      after: null,
    })),
  };
  const service = new ProductSyncService({
    reader,
    brands: { matches: async () => (input.match === null ? [] : [input.match ?? matched]) },
    ledger,
    writer,
    now: () => new Date("2026-10-12T05:00:00.000Z"),
  });
  return { service, ledger, writer, reader };
}

/** Explicit observation-only unit fixture; no retained/live record is claimed. */
function withoutFormula(channel: MarketplaceProduct["channel"]): MarketplaceProduct {
  const url = `https://retailer.example/${channel}/unit-product`;
  return {
    channel,
    listingId: "unit-product",
    variantId: null,
    url,
    runId: "unit-run",
    sourceId: "unit-source",
    brandId,
    brand: "Unit brand",
    collection: null,
    enrichment: null,
    history: {
      codec: "v3-capture-history/1",
      observationId: "unit-capture",
      capturedAt: "2026-10-12T00:00:00.000Z",
      owner: { runId: "unit-run", sourceId: "unit-source", brandId, operationId: "unit-capture" },
      listing: { channel, externalId: "unit-product", url },
      capture: { variantId: null },
      metrics: { price: "0", inStock: false },
      evidence: [],
    },
    product: {
      codec: "channel-product/1",
      channel,
      listingId: "unit-product",
      variantId: null,
      url,
      title: "Title from own page",
      brandRaw: null,
      variantOptions: [],
      variants: [],
      detailsHtml: null,
      factsCandidates: [],
      imageCandidates: [],
      warnings: [],
    },
  };
}

describe("marketplace sync without a formula (unit material doubles)", () => {
  it.each(["amazon", "gnc", "swanson", "wholefoods", "costco"] as const)(
    "%s sends and verifies the own listing and commerce without calling the label endpoint",
    async (channel) => {
      const { service, writer, ledger } = setup({ products: [withoutFormula(channel)] });
      const result = await service.sync({ channel, limit: 50, dryRun: false }, signal());
      expect(result).toMatchObject({
        toSend: 1,
        verified: 1,
        material: 0,
        failed: [],
        runCompleted: true,
      });
      expect(writer.ingest.mock.calls[0]?.[0].items[0]).toMatchObject({
        externalId: "unit-product",
        titleRaw: "Title from own page",
        productName: "Title from own page",
        price: "0",
        inStock: false,
      });
      expect(writer.label).not.toHaveBeenCalled();
      expect(writer.readLabel).not.toHaveBeenCalled();
      expect([...ledger.rows.values()][0]).toMatchObject({
        status: "verified",
        collectedOperationId: null,
      });
    },
  );

  it.each(["missing", "foreign"])(
    "does not send %s own material just because there is no formula",
    async (kind) => {
      const product = withoutFormula("swanson");
      if (kind === "missing") {
        product.product = null;
      } else {
        required(product.history).owner.sourceId = "foreign-source";
      }
      const { service, writer } = setup({ products: [product] });
      const result = await service.sync({ channel: "swanson", limit: 50, dryRun: false }, signal());
      expect(result).toMatchObject({ toSend: 0, verified: 0, material: 1 });
      expect(result.failed[0]?.reason).toBe(
        kind === "missing" ? "PRODUCT_DELIVERY.MATERIAL_MISSING" : "PRODUCT_DELIVERY.INTEGRITY",
      );
      expect(writer.ingest).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(!marketplaceSamplesPath)("marketplace product sync", () => {
  it("dry run counts what would be sent and writes nothing", async () => {
    const { service, ledger, writer } = setup();
    const result = await service.sync({ channel: "gnc", limit: 50, dryRun: true }, signal());
    expect(result).toMatchObject({ read: 2, toSend: 2, waitingCompany: 0, verified: 0 });
    expect(writer.ingest).not.toHaveBeenCalled();
    expect(ledger.rows.size).toBe(0);
  });

  it("sends one partial batch, delivers labels, verifies, and does not resend an unchanged payload", async () => {
    const { service, ledger, writer } = setup();
    const first = await service.sync({ channel: "gnc", limit: 50, dryRun: false }, signal());
    expect(first).toMatchObject({ toSend: 2, verified: 2, failed: [] });
    const run = required(writer.ingest.mock.calls[0])[0].run;
    expect(run).toMatchObject({ channel: "gnc", scope: "partial" });
    expect(run.siteKey).toBeUndefined();
    expect(
      required(writer.ingest.mock.calls[0])[0].items.every(
        (item: { domain: string }) => item.domain === "gnc.com",
      ),
    ).toBe(true);
    expect(writer.label).toHaveBeenCalledTimes(2);
    expect([...ledger.rows.values()].map((row) => row.status)).toEqual(["verified", "verified"]);
    const again = await service.sync({ channel: "gnc", limit: 50, dryRun: false }, signal());
    expect(again).toMatchObject({ unchanged: 2, toSend: 0 });
    expect(writer.ingest).toHaveBeenCalledTimes(1);
  });

  it("only the pending selection can send; a plain read is a count", async () => {
    const { service, reader } = setup();
    await service.sync({ channel: "gnc", limit: 50, dryRun: true }, signal());
    await service.sync({ channel: "gnc", limit: 50, dryRun: false }, signal());
    expect(
      reader.read.mock.calls.map(([request]) => (request as { pending?: boolean }).pending),
    ).toEqual([undefined, true]);
  });

  it("a brand without a matched company waits and nothing is sent", async () => {
    const { service, ledger, writer } = setup({ match: null });
    const result = await service.sync({ channel: "gnc", limit: 50, dryRun: false }, signal());
    expect(result).toMatchObject({ waitingCompany: 2, toSend: 0 });
    expect(writer.ingest).not.toHaveBeenCalled();
    expect([...ledger.rows.values()].every((row) => row.status === "waiting_company")).toBe(true);
  });

  it("a baseline `present` row does not block a product the pending query selected again", async () => {
    // The reader decides staleness (baseline time vs settlement); whatever it returns is planned normally.
    const { service, ledger, writer } = setup();
    await ledger.record(
      products().map((product) => ({
        channel: "gnc",
        listingId: product.listingId,
        variantId: product.variantId,
        status: "present",
      })),
    );
    const result = await service.sync({ channel: "gnc", limit: 50, dryRun: false }, signal());
    expect(result).toMatchObject({ toSend: 2, verified: 2 });
    expect(writer.ingest).toHaveBeenCalledOnce();
  });

  it("judges each item: one refused, one in Supply Smart's identity review, one clean", async () => {
    // Order of first appearance decides the role, however often Supply Smart is asked about an item.
    const order: string[] = [];
    const nth = (ref: string, index: number) => {
      if (!order.includes(ref)) {
        order.push(ref);
      }
      return order.indexOf(ref) === index;
    };
    const writer = supplySmart({
      failRef: (ref) => nth(ref, 0),
      reviewRef: (ref) => nth(ref, 1),
    });
    const { service, ledger } = setup({ writer, ids: ["967060", "424743", "452410"] });
    const result = await service.sync({ channel: "gnc", limit: 50, dryRun: false }, signal());
    expect(result.failed).toEqual([
      expect.objectContaining({ reason: "company_not_found: no company" }),
    ]);
    expect(result).toMatchObject({ verified: 2, needsReview: 1, runCompleted: true });
    const statuses = [...ledger.rows.values()].map((row) => [row.status, row.attempts]);
    expect(statuses.sort()).toEqual([
      ["failed", 1],
      ["verified", 1],
      ["verified", 1],
    ]);
  });

  it("an error after the ingest keeps every product on record as `sent`, never lost", async () => {
    const writer = supplySmart();
    writer.verify.mockRejectedValueOnce(new Error("connection reset"));
    const { service, ledger } = setup({ writer });
    await expect(
      service.sync({ channel: "gnc", limit: 50, dryRun: false }, signal()),
    ).rejects.toThrow("connection reset");
    expect([...ledger.rows.values()].map((row) => row.status)).toEqual(["sent", "sent"]);
  });
});
