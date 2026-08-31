import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AmazonBackfillState } from "./backfill-state.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function state() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amazon-backfill-state-"));
  directories.push(directory);
  return new AmazonBackfillState(path.join(directory, "state.sqlite"));
}

describe("Amazon backfill dual-lane state", () => {
  it("marks existing Formula and OCR evidence ready without waiting for image work", () => {
    const store = state();
    store.seed({ productId: "formula", source: {}, hasFormula: true, hasExistingOcrText: false, imageCount: 2 });
    store.seed({ productId: "ocr", source: {}, hasFormula: false, hasExistingOcrText: true, imageCount: 2 });
    expect(store.get("formula")).toMatchObject({ imageStatus: "ready", formulaStatus: "ready", imageResult: { source: "existing_formula" } });
    expect(store.get("ocr")).toMatchObject({ imageStatus: "ready", formulaStatus: "pending", imageResult: { source: "existing_ocr_text" } });
    store.close();
  });

  it("queues gallery images and reviews products without images", () => {
    const store = state();
    store.seed({ productId: "gallery", source: {}, hasFormula: false, hasExistingOcrText: false, imageCount: 3 });
    store.seed({ productId: "empty", source: {}, hasFormula: false, hasExistingOcrText: false, imageCount: 0 });
    expect(store.get("gallery")).toMatchObject({ imageStatus: "pending", joinStatus: "waiting" });
    expect(store.get("empty")).toMatchObject({
      imageStatus: "review",
      joinStatus: "review",
      review: { image: { reasons: ["no_images"] } },
    });
    store.close();
  });

  it("joins only after both lanes are terminal-ready and resumes interrupted claims", () => {
    const store = state();
    store.seed({ productId: "one", source: { title: "One" }, hasFormula: false, hasExistingOcrText: false, imageCount: 1 });
    expect(store.claimText(1)).toEqual([{ productId: "one", source: { title: "One" } }]);
    expect(store.get("one")?.textStatus).toBe("processing");
    store.recoverInterrupted();
    expect(store.get("one")?.textStatus).toBe("pending");
    store.claimText(1);
    store.recordText("one", "ready", { baseName: "One" });
    expect(store.get("one")?.joinStatus).toBe("waiting");
    expect(store.claimImage(1)).toEqual([{ productId: "one", source: { title: "One" } }]);
    expect(store.get("one")?.imageStatus).toBe("processing");
    store.recordImage("one", "ready", { source: "ocr_facts_candidates", evidenceFile: "one.json" });
    expect(store.get("one")).toMatchObject({ joinStatus: "waiting", formulaStatus: "pending" });
    expect(store.claimFormula(1)).toEqual([{ productId: "one", source: "ocr_facts_candidates", evidenceFile: "one.json" }]);
    store.recordFormula("one", "ready", { rows: 2 });
    expect(store.get("one")?.joinStatus).toBe("ready");
    store.close();
  });

  it("prioritizes image work whose text lane is already ready", () => {
    const store = state();
    store.seed({ productId: "image-first", source: {}, hasFormula: false, hasExistingOcrText: false, imageCount: 1 });
    store.seed({ productId: "join-first", source: {}, hasFormula: false, hasExistingOcrText: false, imageCount: 1 });
    store.claimText(1);
    store.recordText("image-first", "ready", { baseName: "Ready" });
    expect(store.claimImage(1)[0]?.productId).toBe("image-first");
    store.close();
  });

  it("requeues only the image lane while preserving a ready text result", () => {
    const store = state();
    store.seed({ productId: "retry", source: {}, hasFormula: false, hasExistingOcrText: false, imageCount: 1 });
    store.claimText(1);
    store.recordText("retry", "ready", { baseName: "Retry" });
    store.claimImage(1);
    store.recordImage("retry", "review", { evidenceFile: "old.json" }, { reasons: ["partial_image_ocr_failed"] });
    expect(store.retryImage("retry")).toBe(true);
    expect(store.get("retry")).toMatchObject({ textStatus: "ready", imageStatus: "pending", joinStatus: "waiting" });
    expect(store.get("retry")?.review).toEqual({});
    store.close();
  });

  it("requeues a failed text record and prioritizes the retry", () => {
    const store = state();
    store.seed({ productId: "failed", source: {}, hasFormula: true, hasExistingOcrText: false, imageCount: 1 });
    store.seed({ productId: "fresh", source: {}, hasFormula: true, hasExistingOcrText: false, imageCount: 1 });
    store.claimText(1);
    store.recordText("failed", "failed", null, { reasons: ["client_ref_mismatch"] });
    expect(store.retryText("failed")).toBe(true);
    expect(store.claimText(1)[0]?.productId).toBe("failed");
    store.close();
  });

  it("lists ready text results for deterministic reconciliation", () => {
    const store = state();
    store.seed({ productId: "ready", source: {}, hasFormula: true, hasExistingOcrText: false, imageCount: 1 });
    store.claimText(1);
    store.recordText("ready", "ready", { productName: "Name", variant: { size: "60 Count" } });
    expect(store.listReadyTextResults()).toEqual([{
      productId: "ready",
      result: { productName: "Name", variant: { size: "60 Count" } },
    }]);
    store.close();
  });

  it("puts each failed lane in one mechanical review queue", () => {
    const store = state();
    store.seed({ productId: "review", source: { title: "Review" }, hasFormula: false, hasExistingOcrText: true, imageCount: 1 });
    store.claimText(1);
    store.recordText("review", "review", null, { reasons: ["variant_low"] });
    store.claimFormula(1);
    store.recordFormula("review", "review", { confidence: 55 }, { reasons: ["formula_low"] });
    expect(store.listReviewQueue()).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: "review", lane: "text", reasons: { reasons: ["variant_low"] } }),
      expect.objectContaining({ productId: "review", lane: "formula", reasons: { reasons: ["formula_low"] } }),
    ]));
    store.close();
  });

  it("carries Formula review reasons into the Staging task", () => {
    const store = state();
    store.seed({ productId: "formula-review", source: {}, hasFormula: false, hasExistingOcrText: true, imageCount: 1 });
    store.claimText(1);
    store.recordText("formula-review", "ready", { productName: "Review" });
    store.claimFormula(1);
    store.recordFormula("formula-review", "review", null, { reasons: ["facts_panel_has_unreadable_content"] });
    expect(store.claimStaging(1)[0]).toMatchObject({
      review: { formula: { reasons: ["facts_panel_has_unreadable_content"] } },
    });
    store.close();
  });

  it("accepts a Formula vision recovery atomically and requeues Staging", () => {
    const store = state();
    store.seed({ productId: "vision", source: {}, hasFormula: false, hasExistingOcrText: false, imageCount: 1 });
    store.claimText(1);
    store.recordText("vision", "ready", { productName: "Vision" });
    store.claimImage(1);
    store.recordImage("vision", "ready", { source: "ocr_facts_candidates", evidenceFile: "vision.json" });
    store.claimFormula(1);
    store.recordFormula("vision", "review", null, { reasons: ["facts_panel_has_unreadable_content"] });
    store.claimStaging(1);
    store.recordStaging("vision", "review", { targetProductId: "target", reasons: ["join_review"] });

    expect(store.seedFormulaRecovery(10)).toEqual(["vision"]);
    expect(store.claimFormulaRecovery(1)).toEqual([{ productId: "vision", evidenceFile: "vision.json" }]);
    expect(store.acceptFormulaRecovery("vision", { rows: [{ name: "Vitamin C" }] }, { audit: true }))
      .toEqual({ stagingRetried: true });
    expect(store.get("vision")).toMatchObject({
      formulaStatus: "ready",
      joinStatus: "ready",
      stagingStatus: "pending",
      stagingResult: null,
    });
    expect(store.formulaRecoverySummary()).toEqual([{ status: "ready", count: 1 }]);
    expect(store.listReviewQueue()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: "vision", lane: "formula" }),
    ]));
    store.close();
  });

  it("recovers only the requested lane so concurrent workers cannot steal claims", () => {
    const store = state();
    store.seed({ productId: "isolated", source: {}, hasFormula: false, hasExistingOcrText: true, imageCount: 1 });
    store.claimText(1);
    store.claimFormula(1);
    store.recoverInterrupted("formula");
    expect(store.get("isolated")).toMatchObject({ textStatus: "processing", formulaStatus: "pending" });
    store.close();
  });

  it("claims completed joins for idempotent Staging persistence", () => {
    const store = state();
    store.seed({ productId: "stage", source: { external_id: "ASIN1" }, hasFormula: true, hasExistingOcrText: false, imageCount: 1 });
    store.claimText(1);
    store.recordText("stage", "ready", { productName: "Clean", baseName: "Clean", variant: { form: "capsule" }, variantConfidence: 90, variantSource: "ai_extract" });
    expect(store.claimStaging(1)).toEqual([expect.objectContaining({
      productId: "stage",
      joinStatus: "ready",
      formulaSource: "existing_formula",
    })]);
    expect(store.get("stage")?.stagingStatus).toBe("processing");
    store.recordStaging("stage", "ready", { targetProductId: "target" });
    expect(store.get("stage")).toMatchObject({ stagingStatus: "ready", stagingResult: { targetProductId: "target" } });
    expect(store.claimStaging(1)).toEqual([]);
    store.close();
  });

  it("requeues a bounded Staging recovery cohort by exact review reason", () => {
    const store = state();
    for (const productId of ["missing-one", "missing-two", "other"]) {
      store.seed({ productId, source: {}, hasFormula: true, hasExistingOcrText: false, imageCount: 1 });
      store.claimText(1);
      store.recordText(productId, "ready", { productName: productId });
      store.claimStaging(1);
      store.recordStaging(productId, "review", {
        reasons: [productId === "other" ? "other_reason" : "staging_product_not_found_or_ambiguous"],
      });
    }
    expect(store.retryStagingByReason("staging_product_not_found_or_ambiguous", 1)).toHaveLength(1);
    expect(store.stagingSummary()).toEqual(expect.arrayContaining([
      { status: "pending", count: 1 },
      { status: "review", count: 2 },
    ]));
    store.close();
  });
});
