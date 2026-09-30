import { describe, expect, it } from "vitest";
import type { ObjectStore } from "@crawl-automation/platform";
import { hashText } from "@crawl-automation/processing";
import {
  ArtifactRefSchema,
  ReviewRecordSchema,
  TextInputSchema,
  textFingerprint,
  textObservation,
  type ReviewRecord,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import { ReviewEvidence } from "./review-evidence.js";
import { ReviewService, type ReviewStore } from "./review-service.js";
import { TextAnswerRecheck } from "./text-recheck.js";

const TEXT = "Vitamin C 10 mg\nIngredients: water";
const signal = () => AbortSignal.timeout(5_000);

function textTask(): TextInput {
  const owner = {
    schemaVersion: 1 as const,
    requestId: "req-1",
    observationId: "obs-1",
    brandId: "brand-1",
    sourceId: "source-1",
    listingId: "listing-1",
    variantId: null,
  };
  const document = ArtifactRefSchema.parse({
    ...{ schemaVersion: 1, artifactId: "document-1", observationId: "obs-1", sourceId: "source-1" },
    ...{
      listingId: "listing-1",
      variantId: null,
      kind: "result-json",
      mediaType: "application/json",
    },
    ...{ objectKey: "sources/obs-1/document", sha256: "a".repeat(64), byteSize: 10 },
    producer: {
      operationId: "prepare-1",
      module: "page.prepare",
      implementationVersion: "fixture/1",
    },
  });
  const unsigned = {
    ...owner,
    ...{
      module: "codex.text" as const,
      schemaVersion: 1 as const,
      implementationVersion: "text/1",
    },
    ...{
      policyVersion: "extractive/1",
      resultSchemaVersion: 1 as const,
      configFingerprint: "a".repeat(64),
    },
    operationId: "text-op-1",
    source: { kind: "prepared" as const, document },
    range: { start: 0, end: TEXT.length },
  };
  return TextInputSchema.parse({
    ...unsigned,
    inputFingerprint: textFingerprint(unsigned, hashText),
  });
}

function review(input: TextInput, rawResponse: string | null): ReviewRecord {
  return ReviewRecordSchema.parse({
    ...{ schemaVersion: 1, reviewId: "text-review-1", occurredAt: "2026-09-29T00:00:00.000Z" },
    failure: {
      ...{ schemaVersion: 1, requestId: input.requestId, observationId: input.observationId },
      ...{
        operationId: input.operationId,
        inputFingerprint: input.inputFingerprint,
        stage: "codex.text",
      },
      ...{ category: "PROCESSING", code: "TEXT.CITATION_INVALID", executionFact: "executed" },
      ...{
        evidenceKey: `text-intents/${input.operationId}.json`,
        blockedBy: null,
        automaticRetry: false,
      },
    },
    observation: textObservation(input),
    rawError: {
      name: "TextStageError",
      message: "TEXT.CITATION_INVALID",
      stack: null,
      details: {},
    },
    candidate:
      rawResponse === null ? null : { schema: "text-raw-response/1", value: { rawResponse } },
    inspection: { kind: "none" },
  });
}

function objects(files: Record<string, unknown>): Pick<ObjectStore, "read"> {
  return {
    read: async (key: string) => (key in files ? Buffer.from(JSON.stringify(files[key])) : null),
  };
}

function setup(rawResponse: string | null, files?: Record<string, unknown>) {
  const input = textTask();
  const record = review(input, rawResponse);
  const stored = objects(files ?? { [record.failure.evidenceKey]: { input } });
  const sources = { resolve: async () => ({ text: TEXT, refs: [] }) };
  const recheck = new TextAnswerRecheck({ objects: stored, sources });
  const store: ReviewStore = {
    ...{ list: async () => ({ items: [{ reviewId: record.reviewId }] }), find: async () => null },
    ...{ read: async (id: string) => (id === record.reviewId ? record : null) },
    ...{ summary: async () => null },
  };
  const service = new ReviewService({
    reviews: store,
    evidence: { recheck, files: new ReviewEvidence({ objects: stored }) },
  });
  return { input, record, recheck, service };
}

const quote = (text: string, start: number) =>
  JSON.stringify({
    formula: null,
    ingredients: { items: [{ text, start, end: start + text.length }] },
  });

describe("recheck of stored text answers", () => {
  it("passes an answer that today's decoder and quote check accept", async () => {
    const { record, recheck } = setup(quote(TEXT, 0));
    expect(await recheck.check(record, signal())).toMatchObject({ status: "passes", code: null });
  });

  it("reports today's code for an answer that still fails", async () => {
    const { record, recheck } = setup(quote("Vitamin D", 0));
    const result = await recheck.check(record, signal());
    expect(result.status).toBe("fails");
    expect(result.code).toMatch(/^TEXT\./);
  });

  it("is not applicable without a stored answer, and unavailable without the task's intent", async () => {
    expect(await setup(null).recheck.check(setup(null).record, signal())).toMatchObject({
      status: "not_applicable",
    });
    const missing = setup(quote(TEXT, 0), {});
    expect(await missing.recheck.check(missing.record, signal())).toMatchObject({
      status: "unavailable",
    });
  });

  it("rechecks the Reviews a filter selects and counts them by status", async () => {
    const { service } = setup(quote(TEXT, 0));
    const result = await service.recheck({ filter: { code: "TEXT.CITATION_INVALID" }, limit: 10 });
    expect(result.summary).toEqual({ passes: 1, fails: 0, not_applicable: 0, unavailable: 0 });
  });
});

describe("Review evidence", () => {
  it("returns the full record and its intent file", async () => {
    const { service, record, input } = setup(quote(TEXT, 0));
    const evidence = await service.evidence(record.reviewId);
    expect(evidence.review).toEqual(record);
    expect(evidence.files[0]).toMatchObject({ key: record.failure.evidenceKey, status: "present" });
    expect(evidence.files.slice(1).map((file) => file.status)).toEqual(["missing", "missing"]);
    expect(evidence.files[1]?.key).toContain(input.inputFingerprint);
  });

  it("refuses without storage settings", async () => {
    const service = new ReviewService({ reviews: { read: async () => null } as never });
    await expect(service.evidence("any")).rejects.toMatchObject({
      code: "REVIEW.EVIDENCE_NOT_CONFIGURED",
    });
  });
});
