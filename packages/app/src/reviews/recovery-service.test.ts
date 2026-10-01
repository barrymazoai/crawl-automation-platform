import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recheckDigest,
  recheckErrors,
  recoveredCollection,
  type RecheckedLabel,
} from "@crawl-automation/processing";
import { ReviewRecordSchema, type LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import { ReviewRecoveryService } from "./recovery-service.js";
import { ReviewService } from "./review-service.js";
import {
  ReviewRecoveryInputSchema,
  type RecoveryOutcome,
  type RecoveryPreview,
} from "./recovery-model.js";
import type { RecoveryLedger } from "./recovery-ports.js";

// The processing suite verifies the real candidate builder; these tests exercise the application transaction boundary.
vi.mock("@crawl-automation/processing", async (original) => ({
  ...(await original<typeof import("@crawl-automation/processing")>()),
  recoveredCollection: vi.fn(() => ({
    record: { operationId: "recovered-version", observation: { observationId: "observation" } },
    files: [{ key: "recovery/assembly.json", bytes: Buffer.from("derived") }],
  })),
}));

function savedReview() {
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: "review-one",
    occurredAt: "2026-09-30T00:00:00.000Z",
    observation: null,
    failure: {
      schemaVersion: 1,
      requestId: "request",
      observationId: "observation",
      operationId: "product",
      inputFingerprint: "a".repeat(64),
      stage: "product.label.assembly",
      category: "VALIDATION",
      code: "VALIDATION.FORMULA_MISSING",
      executionFact: "unknown",
      evidenceKey: "product/assembly.json",
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: { name: "old-rule", message: "old-rule", stack: null, details: {} },
    candidate: null,
    inspection: { kind: "none" },
  });
}

function readyLabel(): RecheckedLabel {
  return {
    rules: "retained-label/1",
    originalReviewId: "review-one",
    originalReviewHash: "a".repeat(64),
    original: {
      manifest: {
        operationId: "product",
        observation: {
          schemaVersion: 1,
          requestId: "request",
          observationId: "observation",
          brandId: "brand",
          sourceId: "source",
          listingId: "listing",
          variantId: null,
        },
        sources: [],
      },
      states: [],
    },
    result: {
      codec: "label-product-assembly/1",
      status: "ready",
      codes: [],
      warnings: [],
      formula: null,
      otherIngredients: null,
      ingredients: [],
      provenance: [],
    },
    receipts: [],
    files: [],
  };
}

function setup() {
  const review = savedReview();
  const previews = new Map<string, RecoveryPreview>();
  const outcomes = new Map<string, RecoveryOutcome>();
  const collections: LabelCollectedProduct[] = [];
  const bytes = new Map<string, Uint8Array>();
  const reviews = {
    read: vi.fn(async () => structuredClone(review)),
    find: vi.fn(async () => review),
    list: vi.fn(async () => ({ items: [{ reviewId: review.reviewId }] })),
    summary: vi.fn(),
  };
  const ledger = {
    collectionFor: vi.fn(async (): Promise<LabelCollectedProduct | null> => null),
    savePreview: vi.fn(async (value: RecoveryPreview) => {
      previews.set(value.previewId, value);
    }),
    readPreview: vi.fn(async (id: string) => previews.get(id) ?? null),
    status: vi.fn(async (id: string) => outcomes.get(id) ?? null),
    record: vi.fn(
      async (input: Parameters<RecoveryLedger["record"]>[0]): Promise<RecoveryOutcome> => {
        if (input.collection) {
          collections.push(input.collection);
        }
        const result: RecoveryOutcome = {
          ...input.item,
          previewId: input.previewId,
          status: input.collection ? "recovered" : input.item.status,
          superseded: !!input.collection,
          recordedAt: new Date().toISOString(),
          recordHash: input.collection ? "b".repeat(64) : null,
        };
        outcomes.set(result.reviewId, result);
        return result;
      },
    ),
  };
  const objects = {
    read: vi.fn(async (key: string) => bytes.get(key) ?? null),
    create: vi.fn(async (key: string, value: Uint8Array) => {
      bytes.set(key, value);
      return "created" as const;
    }),
  };
  const recheck = { check: vi.fn(async () => readyLabel()) };
  const service = new ReviewRecoveryService({ reviews, ledger, objects, recheck });
  return { service, reviews, ledger, objects, recheck, review, previews, collections };
}

const selection = { reviewIds: ["review-one"] };
afterEach(() => vi.useRealTimers());

describe("manual retained-answer recovery", () => {
  it("reports dry-run readiness, saving only the report and leaving collection and originals untouched", async () => {
    const fake = setup();
    const result = await fake.service.run({ dryRun: true, selection });
    expect(result.items[0]).toMatchObject({
      reviewId: "review-one",
      status: "recoverable",
      codes: [],
    });
    expect(fake.ledger.savePreview).toHaveBeenCalledOnce();
    expect(fake.ledger.record).not.toHaveBeenCalled();
    expect(fake.objects.create).not.toHaveBeenCalled();
    expect(fake.collections).toEqual([]);
    expect(await fake.reviews.read()).toEqual(savedReview());
  });

  it("rechecks the preview, publishes one version, and keeps the original Review readable with recovery metadata", async () => {
    const fake = setup();
    const preview = await fake.service.run({ dryRun: true, selection });
    const result = await fake.service.run({ dryRun: false, previewId: preview.previewId });
    expect(result.items[0]).toMatchObject({
      status: "recovered",
      superseded: true,
      operationId: "recovered-version",
    });
    expect(fake.recheck.check).toHaveBeenCalledTimes(2);
    expect(fake.collections).toHaveLength(1);
    const service = new ReviewService({ reviews: fake.reviews, recovery: fake.service });
    expect(await service.get("review-one")).toMatchObject({
      ...savedReview(),
      recovery: { superseded: true },
    });
    expect(await service.list({ limit: 1 })).toMatchObject({
      items: [{ reviewId: "review-one", recovery: { superseded: true } }],
    });
    expect(await fake.reviews.read()).toEqual(savedReview());
    await fake.service.run({ dryRun: false, previewId: preview.previewId });
    expect(fake.collections).toHaveLength(1);
    expect(fake.objects.create).toHaveBeenCalledOnce();
  });

  it("refuses missing or expired previews", async () => {
    const fake = setup();
    await expect(
      fake.service.run({ dryRun: false, previewId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "RECHECK.PREVIEW_REQUIRED" });
    const preview = await fake.service.run({ dryRun: true, selection });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await expect(
      fake.service.run({ dryRun: false, previewId: preview.previewId }),
    ).rejects.toMatchObject({ code: "RECHECK.PREVIEW_REQUIRED" });
    expect(fake.objects.create).not.toHaveBeenCalled();
  });

  it("refuses evidence or rule changes after preview, before any publication", async () => {
    const fake = setup();
    const preview = await fake.service.run({ dryRun: true, selection });
    const changed = readyLabel();
    changed.result.warnings.push({ id: "new", code: "new-rule" });
    fake.recheck.check.mockResolvedValue(changed);
    await expect(
      fake.service.run({ dryRun: false, previewId: preview.previewId }),
    ).rejects.toMatchObject({ code: "RECHECK.PREVIEW_CHANGED" });
    expect(fake.objects.create).not.toHaveBeenCalled();
    expect(fake.ledger.record).not.toHaveBeenCalled();
  });

  it("keeps still-failing products in Review and records their current codes without publishing", async () => {
    const fake = setup();
    const label = readyLabel();
    label.result.status = "review";
    label.result.codes = ["VALIDATION.INGREDIENTS_MISSING"];
    fake.recheck.check.mockResolvedValue(label);
    const preview = await fake.service.run({ dryRun: true, selection });
    const result = await fake.service.run({ dryRun: false, previewId: preview.previewId });
    expect(result.items[0]).toMatchObject({
      status: "review",
      superseded: false,
      codes: label.result.codes,
    });
    expect(fake.objects.create).not.toHaveBeenCalled();
  });

  it("reports hash/identity failures and never invokes the writer", async () => {
    const fake = setup();
    fake.recheck.check.mockRejectedValue(recheckErrors.create("RECHECK.IDENTITY_CONFLICT"));
    const result = await fake.service.run({ dryRun: true, selection });
    expect(result.items[0]).toMatchObject({
      status: "unavailable",
      codes: ["RECHECK.IDENTITY_CONFLICT"],
    });
    expect(fake.objects.create).not.toHaveBeenCalled();
  });

  it("enforces bounded, duplicate-free selection and defaults to dry run", () => {
    expect(ReviewRecoveryInputSchema.parse({ selection }).dryRun).toBe(true);
    expect(
      ReviewRecoveryInputSchema.safeParse({ selection: { reviewIds: Array(26).fill("id") } })
        .success,
    ).toBe(false);
    expect(
      ReviewRecoveryInputSchema.safeParse({ selection: { reviewIds: ["same", "same"] } }).success,
    ).toBe(false);
    expect(
      ReviewRecoveryInputSchema.safeParse({ selection: { filter: {}, limit: 26 } }).success,
    ).toBe(false);
  });

  it("bounds filter selection and includes exactly those reviews in the durable preview", async () => {
    const fake = setup();
    const result = await fake.service.run({
      dryRun: true,
      selection: { filter: { stage: "product.label.assembly" }, limit: 1 },
    });
    expect(result.items).toHaveLength(1);
    expect(fake.reviews.list).toHaveBeenCalledWith({ stage: "product.label.assembly", limit: 1 });
    expect(result.items[0]?.originalReviewHash).toBe(recheckDigest(savedReview()));
  });

  it("does not register when immutable derived bytes cannot be confirmed", async () => {
    const fake = setup();
    const preview = await fake.service.run({ dryRun: true, selection });
    fake.objects.read.mockResolvedValue(Buffer.from("different"));
    await expect(
      fake.service.run({ dryRun: false, previewId: preview.previewId }),
    ).rejects.toMatchObject({ code: "RECHECK.PUBLICATION_UNVERIFIED" });
    expect(fake.ledger.record).not.toHaveBeenCalled();
  });

  it("reports an existing different collection during dry run instead of promising an overwrite", async () => {
    const fake = setup();
    fake.ledger.collectionFor.mockResolvedValue({
      ...recoveredCollection(readyLabel()).record,
      operationId: "existing",
    });
    const report = await fake.service.run({ dryRun: true, selection });
    expect(report.items[0]).toMatchObject({
      status: "unavailable",
      codes: ["LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED"],
    });
    expect(fake.objects.create).not.toHaveBeenCalled();
  });

  it("confirms a lost object-write acknowledgement by reading back, without writing again", async () => {
    const fake = setup();
    const preview = await fake.service.run({ dryRun: true, selection });
    const create = fake.objects.create.getMockImplementation();
    if (!create) {
      throw new Error("missing test writer");
    }
    fake.objects.create.mockImplementation(async (key, bytes) => {
      await create(key, bytes);
      throw new Error("lost acknowledgement");
    });
    const result = await fake.service.run({ dryRun: false, previewId: preview.previewId });
    expect(result.items[0]?.status).toBe("recovered");
    expect(fake.objects.create).toHaveBeenCalledOnce();
  });
});
