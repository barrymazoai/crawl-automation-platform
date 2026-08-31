import { describe, expect, it } from "vitest";
import { CapturedProductBatchV1Schema, EvidenceBundleV1Schema, jobStages, nodeCapabilities } from "./index";

describe("EvidenceBundleV1", () => {
  it("rejects a mismatched item count", () => {
    const result = EvidenceBundleV1Schema.safeParse({
      schemaVersion: "1.0",
      runId: "9e098108-aab7-4c4e-8f47-27122de73590",
      batchId: "9600232d-431a-4796-bc65-3fd06836fd5f",
      ordinal: 0,
      sourceUrl: "https://example.com",
      sourceType: "dtc_browser",
      adapter: null,
      capturedAt: new Date().toISOString(),
      itemCount: 1,
      items: [],
      files: [],
      capture: { nodeId: "windows-1", promptVersion: "v1", skillRevision: null, pageCount: 1, complete: true },
    });
    expect(result.success).toBe(false);
  });
});

describe("pipeline v2 contracts", () => {
  it("keeps v1 stages and adds the v2 pipeline stages", () => {
    expect(jobStages).toEqual([
      "capture", "process", "ingest", "cleanup",
      "capture_catalog", "process_text", "process_images", "product_join", "product_unify",
      "catalog_finalize", "ingest_staging", "cleanup_run",
    ]);
    expect(nodeCapabilities).toEqual([
      "browser", "amazon", "gnc", "swanson", "process", "ingest", "cleanup",
      "process_text", "process_images", "product_join", "product_unify",
      "catalog_finalize", "ingest_staging", "cleanup_run",
    ]);
  });
});

describe("CapturedProductBatchV1", () => {
  const product = {
    externalId: "379969",
    sku: "GNC-379969",
    productUrl: "https://www.gnc.com/whey-protein/379969.html",
    brandRaw: "GNC",
    titleRaw: "Whey Protein",
    price: "39.99",
    currency: "USD",
    availability: "in_stock",
    rating: 4.5,
    reviewCount: 120,
    unitsSoldText: null,
    rawVariantAttrs: { flavor: "Vanilla" },
    descriptionText: "desc",
    detailText: null,
    ingredientText: null,
    factsEvidence: { htmlTable: "<table></table>", pdfUrl: null, imageRefs: [] },
    images: ["https://cdn.example.com/1.jpg"],
    sourceFiles: ["captured/379969.json"],
    captureCompleteness: "full",
    capturedAt: new Date().toISOString(),
  };
  const batch = {
    schemaVersion: "1.0",
    sourceType: "sales_channel",
    channel: "gnc",
    adapter: "gnc",
    runId: "9e098108-aab7-4c4e-8f47-27122de73590",
    batchId: "batch-000001",
    ordinal: 0,
    catalogKey: "gnc.com/brand/gnc",
    capturedAt: new Date().toISOString(),
    itemCount: 1,
    products: [product],
  };

  it("accepts a complete batch", () => {
    expect(CapturedProductBatchV1Schema.safeParse(batch).success).toBe(true);
  });

  it("rejects a mismatched item count", () => {
    expect(CapturedProductBatchV1Schema.safeParse({ ...batch, itemCount: 2 }).success).toBe(false);
  });

  it("rejects a product without facts evidence", () => {
    const { factsEvidence: _evidence, ...incomplete } = product;
    expect(CapturedProductBatchV1Schema.safeParse({ ...batch, products: [incomplete] }).success).toBe(false);
  });
});
