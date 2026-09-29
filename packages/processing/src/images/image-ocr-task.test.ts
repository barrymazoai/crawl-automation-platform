import { describe, expect, it } from "vitest";
import { sha256 } from "@crawl-automation/v3-artifacts";
import {
  AcquiredFileRecordSchema,
  acquisitionFingerprintMaterial,
  observationIdentity,
  parseOcrInput,
  type AcquiredFileRecord,
  type FileAcquireInput,
  type FileAcquireOutcome,
  type FileOcrPlan,
} from "@crawl-automation/v3-contracts";
import { hashString } from "../results/result-record.js";
import { buildStepReview } from "../step/step-review.js";
import { MemoryReviews } from "../testing/memory-ledgers.js";
import { MemoryStore } from "../testing/memory-store.js";
import { PNG, signal } from "../testing/ocr-fixture.js";
import { ImageOcrTask, type DownloadedFiles } from "./image-ocr-task.js";

function downloadTask(): FileAcquireInput {
  const unsigned = {
    schemaVersion: 1 as const,
    requestId: "req-1",
    observationId: "obs-1",
    operationId: "file-op-1",
    brandId: "brand-1",
    sourceId: "source-1",
    listingId: "listing-1",
    variantId: null,
    module: "file.acquire" as const,
    implementationVersion: "1",
    policyVersion: "1",
    configFingerprint: "c".repeat(64),
    inputFingerprint: "0".repeat(64),
    resourceId: "image-1",
    binding: { sessionId: "session-1", egressId: "direct/1" },
    expectedSha256: null,
  };
  return { ...unsigned, inputFingerprint: hashString(acquisitionFingerprintMaterial(unsigned)) };
}

function downloaded(input: FileAcquireInput, bytes: Buffer, kind: "source-image" | "source-pdf") {
  const mediaType = kind === "source-image" ? ("image/png" as const) : ("application/pdf" as const);
  const file = {
    schemaVersion: 1 as const,
    artifactId: `file-${hashString(input.operationId)}`,
    observationId: input.observationId,
    sourceId: input.sourceId,
    listingId: input.listingId,
    variantId: null,
    kind,
    mediaType,
    sha256: sha256(bytes),
    byteSize: bytes.length,
    objectKey: `v3/${input.observationId}/${input.operationId}/source`,
    producer: {
      operationId: input.operationId,
      module: "file.acquire",
      implementationVersion: "1",
    },
  };
  const record = {
    schemaVersion: 1,
    codec: "acquired-file/1",
    input,
    file,
    dimensions: null,
    redirects: 0,
  };
  return AcquiredFileRecordSchema.parse(record);
}

/** The download step's records, as its own reader would return them. */
function downloads(records: Map<string, AcquiredFileRecord>): DownloadedFiles {
  return {
    inspect: async (input) => records.get(input.operationId) ?? null,
    evidenceKey: (input) => `v3/acquisition/${input.operationId}/completion.json`,
    imageId: (operationId) => `file-${hashString(operationId)}`,
  };
}

function imageSetup(kind: "source-image" | "source-pdf" = "source-image") {
  const input = downloadTask();
  const bytes = kind === "source-image" ? PNG : Buffer.from("%PDF-1.4\n%%EOF\n");
  const record = downloaded(input, bytes, kind);
  const records = new Map([[input.operationId, record]]);
  const deps = {
    downloads: downloads(records),
    local: new MemoryStore(),
    remote: new MemoryStore(),
    reviews: new MemoryReviews(),
  };
  const plan: FileOcrPlan = {
    acquire: input,
    imageId: `file-${hashString(input.operationId)}`,
    ocrOperationId: "ocr-op-1",
    ocr: {
      module: "ocr.file",
      schemaVersion: 1,
      resultSchemaVersion: 2,
      implementationVersion: "ocr/1",
      policyVersion: "policy/1",
      configFingerprint: "a".repeat(64),
    },
  };
  const receipt: FileAcquireOutcome = {
    status: "durable",
    operationId: input.operationId,
    file: record.file,
    evidenceKey: deps.downloads.evidenceKey(input),
  };
  return { input, record, records, deps, plan, receipt, step: new ImageOcrTask(deps) };
}

// Cases carried over from the former image OCR preparation.
describe("image OCR task", () => {
  it("builds a correctly signed OCR task from the verified download and publishes it once", async () => {
    const fixture = imageSetup();
    const prepared = await fixture.step.run(
      { plan: fixture.plan, receipt: fixture.receipt },
      signal(),
    );
    expect(prepared.status).toBe("prepared");
    const { task } = prepared as Extract<typeof prepared, { status: "prepared" }>;
    expect(parseOcrInput(task, hashString).file.sha256).toBe(sha256(PNG));
    expect(task.operationId).toBe("ocr-op-1");
    const writes = fixture.deps.remote.writes;
    const fresh = new ImageOcrTask({ ...fixture.deps, local: new MemoryStore() });
    expect(await fresh.run({ plan: fixture.plan, receipt: fixture.receipt }, signal())).toEqual(
      prepared,
    );
    expect(fixture.deps.remote.writes).toBe(writes);
  });

  it("passes the download's own Review on, and refuses another image's plan", async () => {
    const fixture = imageSetup();
    const { input } = fixture;
    const downloadReview = buildStepReview({
      reviewId: "acquire-1",
      task: input,
      observation: observationIdentity(input),
      stage: "file.acquire",
      category: "ARTIFACT",
      code: "SOURCE.HTTP_STATUS",
      fact: "unknown",
      evidenceKey: "acquisition-reviews/acquire-1.json",
      blockedBy: null,
      error: { name: "AcquisitionFailure", details: {} },
      candidate: null,
      inspection: { kind: "none" },
    });
    await fixture.deps.reviews.append(downloadReview);
    const receipt = {
      status: "review" as const,
      operationId: input.operationId,
      reviewId: "acquire-1",
      code: "SOURCE.HTTP_STATUS",
      evidenceKey: "acquisition-reviews/acquire-1.json",
      automaticRetry: false as const,
    };
    expect(await fixture.step.run({ plan: fixture.plan, receipt }, signal())).toEqual(receipt);
    expect(fixture.deps.reviews.records.size).toBe(1);
    const foreign = { ...fixture.plan, imageId: "foreign-image" };
    expect(await fixture.step.run({ plan: foreign, receipt }, signal())).toMatchObject({
      status: "review",
      code: "IMAGE.IDENTITY_CONFLICT",
    });
  });

  it("a PDF is never passed off as an OCR-ready image", async () => {
    const fixture = imageSetup("source-pdf");
    expect(
      await fixture.step.run({ plan: fixture.plan, receipt: fixture.receipt }, signal()),
    ).toMatchObject({
      status: "review",
      code: "IMAGE.PDF_ROUTE_REQUIRED",
    });
  });

  it("a download that is not durable is a Review, kept locally first", async () => {
    const fixture = imageSetup();
    fixture.records.clear();
    const outcome = await fixture.step.run(
      { plan: fixture.plan, receipt: fixture.receipt },
      signal(),
    );
    expect(outcome).toMatchObject({
      status: "review",
      code: "ACQUIRE.NOT_DURABLE",
      automaticRetry: false,
    });
    const evidenceKey = (outcome as { evidenceKey: string }).evidenceKey;
    expect(fixture.deps.local.data.has(evidenceKey)).toBe(true);
  });
});
