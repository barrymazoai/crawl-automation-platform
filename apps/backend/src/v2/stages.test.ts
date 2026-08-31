import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishReadyMarker, writeJsonAtomic } from "@crawl-automation/runtime";
import type { ExtractedGncProduct } from "../gnc/extract.js";
import type { GncCleanResult } from "../gnc/semantic.js";
import { batchDirectory, READY } from "./paths.js";
import { runCatalogFinalizeStage, runProductJoinStage, type StageContext } from "./stages.js";
import { createGncChannelHooks } from "./channels/gnc.js";

const RUN_ID = "run-1";

function hooks() {
  return createGncChannelHooks({ pdfRenderScript: "" });
}

function product(sku: string): ExtractedGncProduct {
  return {
    sku, mpn: null, title: `GNC Product ${sku}`, brand: "GNC", description: null,
    price: "19.99", currency: "USD", inStock: true, rating: null, reviewCount: null,
    images: [], productUrl: `https://www.gnc.com/item/${sku}.html`, labelPdfUrl: null,
    family: null, variantAttrs: {}, detailText: "", factsText: "", capturedAt: new Date().toISOString(),
  };
}

function semantic(sku: string): GncCleanResult {
  return {
    sku, healthFunctions: ["Immune Support"], productForm: "capsule", ingredients: ["Vitamin C"],
    scopeDecision: "included", scopeReason: "nutrition_product", scopeEvidence: ["Vitamin C 500 mg"],
  };
}

function unified(sku: string) {
  return {
    clientRef: sku, productName: `GNC Product ${sku}`, baseName: null, variant: {},
    variantConfidence: 90, variantSource: "channel_attrs" as const, attrsRaw: {},
  };
}

function context(workRoot: string, overrides: Partial<StageContext> = {}): StageContext {
  return {
    workRoot, runId: RUN_ID, sourceUrl: "https://www.gnc.com/brands/gnc/",
    signal: new AbortController().signal,
    ocr: {} as any,
    supplySmart: { resolveCompanyDomain: async () => "gnc.com", loadHealthFunctions: async () => ["Immune Support"] } as any,
    productWriter: {} as any,
    ocrConcurrency: 4, forcePartialScope: false,
    runModel: async () => { throw new Error("这个测试不应触发模型调用"); },
    ...overrides,
  };
}

async function writeBatch(workRoot: string, batchId: string, products: ExtractedGncProduct[]) {
  const capture = batchDirectory(workRoot, RUN_ID, "capture", batchId);
  for (const item of products) await writeJsonAtomic(path.join(capture, "products", `${item.sku}.json`), item);
  await publishReadyMarker(capture, READY.capture, { batchId, itemCount: products.length });
}

async function writeProcessedBatch(workRoot: string, batchId: string, skus: string[], unifiedSkus: string[]) {
  await writeBatch(workRoot, batchId, skus.map(product));
  await writeJsonAtomic(path.join(batchDirectory(workRoot, RUN_ID, "join", batchId), "join.json"), {
    items: skus.map((sku) => ({ key: sku, semantic: semantic(sku), facts: null })),
    warnings: [],
  });
  const unifyDirectory = batchDirectory(workRoot, RUN_ID, "unify", batchId);
  await writeJsonAtomic(path.join(unifyDirectory, "unify.json"), { results: unifiedSkus.map(unified), problems: [] });
  await publishReadyMarker(unifyDirectory, READY.unify, { batchId });
}

describe("v2 generic stages with gnc hooks", () => {
  let workRoot: string;
  beforeEach(async () => { workRoot = await mkdtemp(path.join(tmpdir(), "v2-stages-")); });
  afterEach(async () => { await rm(workRoot, { recursive: true, force: true }); });

  it("product_join merges the text lane and does not wait for a missing image lane", async () => {
    const batchId = "batch-000001";
    await writeBatch(workRoot, batchId, [product("100001")]);
    await writeJsonAtomic(path.join(batchDirectory(workRoot, RUN_ID, "text", batchId), "text.json"), {
      semantic: { results: [semantic("100001")], warnings: [] },
      facts: [{ key: "100001", result: { labelText: "", ingredientNames: [], facts: null, extractionMethod: "html_table" } }],
    });
    const payload = { batchId, ordinal: 0, itemCount: 1, batchDirectory: "x" };
    const output = await runProductJoinStage(hooks(), context(workRoot), payload);
    expect(output).toMatchObject({ batchId, itemCount: 1, resumed: false });
    const resumed = await runProductJoinStage(hooks(), context(workRoot), payload);
    expect(resumed).toMatchObject({ resumed: true });
  });

  it("catalog_finalize quarantines a product without a unify result and demotes scope to partial", async () => {
    await writeProcessedBatch(workRoot, "batch-000001", ["100001", "100002", "100003"], ["100001", "100002"]);
    const output = await runCatalogFinalizeStage(hooks(), context(workRoot), {
      inputKind: "brand_catalog", exhausted: true, truncated: false, expectedCount: 3, discoveredCount: 3, processedCount: 3,
    });
    expect(output.quarantinedCount).toBe(1);
    expect(output.includedCount).toBe(2);
    expect(output.scope).toBe("partial");
    expect(output.reasons).toContain("quarantined:1");
  });

  it("catalog_finalize grants full scope on a clean exhaustive run", async () => {
    await writeProcessedBatch(workRoot, "batch-000001", ["100001"], ["100001"]);
    const output = await runCatalogFinalizeStage(hooks(), context(workRoot), {
      inputKind: "brand_catalog", exhausted: true, truncated: false, expectedCount: 1, discoveredCount: 1, processedCount: 1,
    });
    expect(output.scope).toBe("full");
    expect(output.quarantinedCount).toBe(0);
  });

  it("catalog_finalize honors FORCE_PARTIAL_SCOPE even on a clean run", async () => {
    await writeProcessedBatch(workRoot, "batch-000001", ["100001"], ["100001"]);
    const output = await runCatalogFinalizeStage(hooks(), context(workRoot, { forcePartialScope: true }), {
      inputKind: "brand_catalog", exhausted: true, truncated: false, expectedCount: 1, discoveredCount: 1, processedCount: 1,
    });
    expect(output.scope).toBe("partial");
    expect(output.reasons).toContain("force_partial_scope_enabled");
  });

  it("catalog_finalize resumes from its ready marker without recomputation", async () => {
    await writeProcessedBatch(workRoot, "batch-000001", ["100001"], ["100001"]);
    const payload = { inputKind: "brand_catalog", exhausted: true, truncated: false, expectedCount: 1, discoveredCount: 1, processedCount: 1 };
    const first = await runCatalogFinalizeStage(hooks(), context(workRoot), payload);
    // 第二次调用换一个拒绝任何查询的 supplySmart 和全新钩子：命中 ready 标记就不应再计算。
    const second = await runCatalogFinalizeStage(hooks(), context(workRoot, {
      supplySmart: { resolveCompanyDomain: async () => { throw new Error("不应重新计算"); } } as any,
    }), payload);
    expect(second).toEqual(first);
  });
});
