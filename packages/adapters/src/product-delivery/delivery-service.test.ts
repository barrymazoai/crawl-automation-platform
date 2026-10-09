import { describe, expect, it } from "vitest";
import { ProductDeliveryService, type DeliverySnapshot } from "@crawl-automation/app";
import { deliveryProduct, deliveryRequest, deliverySnapshot } from "./product.fixture.js";
import { DeliveryRpcFake } from "./rpc.fixture.js";
import { SupplySmartObservationWriter } from "./product-observation-writer.js";

function setup(snapshot: DeliverySnapshot = deliverySnapshot()) {
  const rpc = new DeliveryRpcFake();
  const service = new ProductDeliveryService({
    reader: { read: async () => snapshot, catalogs: async () => [] },
    writer: new SupplySmartObservationWriter(rpc),
  });
  return { rpc, run: () => service.deliver(deliveryRequest, new AbortController().signal) };
}

describe("Supply Smart product delivery with real answer codecs and fake RPC", () => {
  it("ingests, reads each full label back, verifies and then completes a proven full scan", async () => {
    const state = setup();
    expect(await state.run()).toEqual({ captured: 1, review: 0, delivered: 1, refused: [] });
    expect(state.rpc.calls.map((call) => call.path)).toEqual([
      "product.ingestObservationBatch",
      "product.ingestLabelObservation",
      "product.getLabelObservation",
      "product.verifyObservationBatch",
      "product.completeCrawlRun",
    ]);
    expect(state.rpc.calls[0]?.input).toMatchObject({
      run: {
        runId: deliveryRequest.ingestRunId,
        channel: "dtc",
        scope: "full",
        companyDomain: "example.com",
        startedAt: "2026-10-09T01:00:00.000Z",
        source: `crawl-automation:${deliveryRequest.ingestRunId}`,
      },
    });
  });

  it("continues accepted products when another item is refused and never completes that run", async () => {
    const state = setup(deliverySnapshot([deliveryProduct("1"), deliveryProduct("2")]));
    state.rpc.refused.add("variant-1");
    expect(await state.run()).toEqual({
      captured: 2,
      review: 0,
      delivered: 1,
      refused: [{ externalId: "variant-1", reason: "company_not_found: Brand not registered" }],
    });
    expect(state.rpc.calls.some((call) => call.path === "product.completeCrawlRun")).toBe(false);
  });

  it.each(["review", "pending", "missingScan", "partial", "recent", "unresolved"])(
    "keeps %s coverage partial",
    async (kind) => {
      const snapshot = deliverySnapshot();
      if (kind === "review") {
        snapshot.review = 1;
      }
      if (kind === "pending") {
        snapshot.pending = 1;
      }
      if (kind === "missingScan") {
        snapshot.scans = [];
      }
      const scan = snapshot.scans[0];
      const changes: Record<string, object> = {
        partial: { full: false },
        recent: { recent: 1 },
        unresolved: { unresolvedFamilies: 1 },
      };
      Object.assign(scan ?? {}, changes[kind]);
      const state = setup(snapshot);
      const result = await state.run();
      expect(result.delivered).toBe(1);
      expect(result.review).toBe(kind === "review" ? 1 : 0);
      expect(state.rpc.calls[0]?.input).toMatchObject({ run: { scope: "partial" } });
      expect(state.rpc.calls.some((call) => call.path === "product.completeCrawlRun")).toBe(false);
    },
  );

  it.each(["verifyProblems", "verifyMissing", "readMismatch", "labelFailure"] as const)(
    "does not count unverified delivery: %s",
    async (condition) => {
      const state = setup();
      if (condition === "verifyProblems") {
        state.rpc.verifyProblems = ["readback_mismatch"];
      } else {
        state.rpc[condition] = true;
      }
      expect(await state.run()).toMatchObject({
        delivered: 0,
        refused: [{ externalId: "variant-1" }],
      });
      expect(state.rpc.calls.some((call) => call.path === "product.completeCrawlRun")).toBe(false);
    },
  );

  it("delivers into a still-open partial run: run_not_completed is not a product problem (Kate Farms)", async () => {
    const state = setup();
    state.rpc.verifyProblems = ["run_not_completed"];
    expect(await state.run()).toMatchObject({ delivered: 1, refused: [] });
  });

  it("isolates item-level verification problems", async () => {
    const state = setup(deliverySnapshot([deliveryProduct("1"), deliveryProduct("2")]));
    state.rpc.itemProblem = "variant-1";
    expect(await state.run()).toMatchObject({
      delivered: 1,
      refused: [{ externalId: "variant-1", reason: "needs_review" }],
    });
  });

  it("does not declare full scope when one website variant lacks a settled collection", async () => {
    const product = deliveryProduct();
    product.product?.variants.push({
      listingId: "product-1",
      variantId: "missing",
      url: "https://example.com/products/focusfuel?variant=missing",
      title: "60 Count",
    });
    const state = setup(deliverySnapshot([product]));
    expect((await state.run()).delivered).toBe(1);
    expect(state.rpc.calls[0]?.input).toMatchObject({ run: { scope: "partial" } });
  });

  it("keeps shared-site brand scans partial to avoid deactivating another sub-brand's listings", async () => {
    const snapshot = deliverySnapshot();
    const scan = snapshot.scans[0];
    if (scan) {
      scan.siteScope = "multi-brand";
    }
    const state = setup(snapshot);
    expect((await state.run()).delivered).toBe(1);
    expect(state.rpc.calls[0]?.input).toMatchObject({ run: { scope: "partial" } });
  });

  it("does not issue empty batches and does not deliver Review records", async () => {
    const state = setup({ products: [], review: 4, pending: 0, scans: [] });
    expect(await state.run()).toEqual({ captured: 0, review: 4, delivered: 0, refused: [] });
    expect(state.rpc.calls).toEqual([]);
  });

  it("uses batches of at most 200, and replay keeps every label ledger key and body stable", async () => {
    const products = Array.from({ length: 201 }, (_, index) => deliveryProduct(String(index)));
    const state = setup(deliverySnapshot(products));
    expect((await state.run()).delivered).toBe(201);
    const batches = state.rpc.calls.filter(
      (call) => call.path === "product.ingestObservationBatch",
    );
    expect(batches.map((call) => (call.input as { items: unknown[] }).items.length)).toEqual([
      200, 1,
    ]);
    const first = [...state.rpc.labels.values()];
    expect((await state.run()).delivered).toBe(201);
    expect([...state.rpc.labels.values()]).toEqual(first);
  });
});
