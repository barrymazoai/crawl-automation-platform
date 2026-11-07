import { describe, expect, it, vi } from "vitest";
import { DtcSourceDelivery, type DtcPreviewDelivery } from "./source-delivery.js";

const companyId = "9d55fe85-7ed1-4714-a96f-4061c67143a5";
const own = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const retailer = "33333333-3333-4333-8333-333333333333";
const signal = new AbortController().signal;
const outcome = { captured: 3, review: 1, delivered: 2, refused: [] };

function fake(): DtcPreviewDelivery &
  Record<"catalogs" | "deliver" | "preview", ReturnType<typeof vi.fn>> {
  return {
    catalogs: vi.fn(async () => [
      { sourceId: own, catalogUrl: "https://www.brand.com/collections/all" },
      { sourceId: second, catalogUrl: "https://brand.com/collections/gummies" },
      { sourceId: retailer, catalogUrl: "https://shop.example.com/collections/brand" },
    ]),
    deliver: vi.fn(async () => outcome),
    preview: vi.fn(async () => ({ ...outcome, delivered: 0, deliverable: 2 })),
  };
}

describe("DtcSourceDelivery", () => {
  it("previews by default, one stable ingest run per catalog domain, without sending", async () => {
    const production = fake();
    const result = await new DtcSourceDelivery({ deliveries: { production } }).deliver(
      { companyId, sourceIds: [second, own, retailer, own], target: "production" },
      signal,
    );
    expect(production.deliver).not.toHaveBeenCalled();
    expect(production.catalogs).toHaveBeenCalledExactlyOnceWith([second, own, retailer], signal);
    expect(production.preview.mock.calls.map(([request]) => request)).toEqual([
      {
        companyId,
        siteKey: "brand.com",
        sourceIds: [own, second].sort(),
        ingestRunId: `dtc-company-${companyId}-brand.com`,
      },
      {
        companyId,
        siteKey: "shop.example.com",
        sourceIds: [retailer],
        ingestRunId: `dtc-company-${companyId}-shop.example.com`,
      },
    ]);
    expect(result).toMatchObject({ target: "production", dryRun: true, companyId });
    expect(result.groups[0]).toMatchObject({ siteKey: "brand.com", deliverable: 2, delivered: 0 });
  });

  it("sends only to the named target when dryRun is false", async () => {
    const production = fake();
    const test = fake();
    const result = await new DtcSourceDelivery({ deliveries: { production, test } }).deliver(
      { companyId, sourceIds: [own], target: "test", dryRun: false },
      signal,
    );
    expect(production.catalogs).not.toHaveBeenCalled();
    expect(test.deliver).toHaveBeenCalledOnce();
    expect(test.preview).not.toHaveBeenCalled();
    expect(result.groups).toEqual([
      { siteKey: "brand.com", sourceIds: [own], ...outcome, deliverable: null },
    ]);
  });

  it("refuses an unconfigured target before reading anything", async () => {
    const production = fake();
    await expect(
      new DtcSourceDelivery({ deliveries: { production } }).deliver(
        { companyId, sourceIds: [own], target: "test", dryRun: false },
        signal,
      ),
    ).rejects.toMatchObject({ code: "PRODUCT_DELIVERY.TARGET_MISSING" });
    expect(production.catalogs).not.toHaveBeenCalled();
  });

  it("refuses a source without exactly one catalog instead of guessing its domain", async () => {
    const production = fake();
    const unknown = "44444444-4444-4444-8444-444444444444";
    await expect(
      new DtcSourceDelivery({ deliveries: { production } }).deliver(
        { companyId, sourceIds: [own, unknown], target: "production", dryRun: false },
        signal,
      ),
    ).rejects.toMatchObject({ code: "BRAND_ENRICHMENT.IDENTITY_UNRESOLVED" });
    expect(production.deliver).not.toHaveBeenCalled();
  });

  it.each([
    { companyId: "x", sourceIds: [own], target: "production" },
    { companyId, sourceIds: [], target: "production" },
    { companyId, sourceIds: [own] },
    { companyId, sourceIds: [own], target: "staging" },
  ])("rejects invalid input %j", async (input) => {
    const production = fake();
    await expect(
      new DtcSourceDelivery({ deliveries: { production } }).deliver(input, signal),
    ).rejects.toThrow();
    expect(production.catalogs).not.toHaveBeenCalled();
  });
});
