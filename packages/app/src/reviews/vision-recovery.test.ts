import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  decodeVisionResult,
  prepareVisionRecord,
  recheckDigest,
} from "@crawl-automation/processing";
import {
  ReviewRecordSchema,
  VisionTaskSchema,
  type VisionRecord,
} from "@crawl-automation/v3-contracts";
import { ReviewRecoveryService } from "./recovery-service.js";
import type { RecoveryLedger } from "./recovery-ports.js";
import type { RecoveryOutcome, RecoveryPreview } from "./recovery-model.js";

const corpus = new URL(
  "../../../../tools/diag-corpus/amount-state/vision-fc397c07-85ea-4d49-b110-132ccfb620bb.json",
  import.meta.url,
);

function setup() {
  const entry = JSON.parse(readFileSync(corpus, "utf8")) as {
    review: unknown;
    files: { key: string; content: unknown }[];
  };
  const review = ReviewRecordSchema.parse(entry.review);
  const task = VisionTaskSchema.parse((review.rawError.details as { task: unknown }).task);
  const saved = entry.files.find((file) => file.key === review.failure.evidenceKey)?.content;
  if (!saved) {
    throw new Error("corpus response missing");
  }
  const bytes = Buffer.from(JSON.stringify(saved));
  const raw = (saved as { raw: string }).raw;
  const decoded = decodeVisionResult(task.input, raw);
  const files = new Map([[review.failure.evidenceKey, bytes]]);
  const previews = new Map<string, RecoveryPreview>();
  const outcomes = new Map<string, RecoveryOutcome>();
  const records = new Map<string, VisionRecord>();
  const objects = {
    read: vi.fn(async (key: string) => files.get(key) ?? null),
    create: vi.fn(async () => "created" as const),
  };
  const evidence = {
    verify: vi.fn(async () => ({
      bytes,
      status: decoded.status as "candidate" | "partial",
      candidate: decoded.candidate,
      inR2: true,
    })),
  };
  const results = {
    stageReviewed: vi.fn(async () => {
      const prepared = prepareVisionRecord(
        task,
        { bytes, status: decoded.status as "candidate" | "partial" },
        "storage",
      );
      return prepared.record;
    }),
  };
  const ledger: RecoveryLedger = {
    supportsVision: true,
    collectionFor: async () => null,
    savePreview: async (value) => {
      previews.set(value.previewId, value);
    },
    readPreview: async (id) => previews.get(id) ?? null,
    status: async (id) => outcomes.get(id) ?? null,
    record: async ({ item, previewId, vision }) => {
      if (vision) {
        records.set(vision.input.operationId, vision);
      }
      const result: RecoveryOutcome = {
        ...item,
        previewId,
        status: vision ? "recovered" : item.status,
        superseded: !!vision,
        recordHash: vision ? recheckDigest(vision) : null,
        recordedAt: new Date().toISOString(),
      };
      outcomes.set(item.reviewId, result);
      return result;
    },
  };
  const reviews = {
    read: vi.fn(async () => structuredClone(review)),
    find: async () => review,
    list: async () => ({ items: [{ reviewId: review.reviewId }] }),
    summary: async () => null,
  };
  const service = new ReviewRecoveryService({
    reviews,
    ledger,
    objects,
    recheck: {
      check: async () => {
        throw new Error("assembly path used");
      },
    },
    vision: { evidence, results },
  });
  return { service, review, task, objects, evidence, results, records, outcomes, reviews, ledger };
}

describe.skipIf(!existsSync(corpus))("retained vision Review recovery", () => {
  it("previews the current answer and candidate without publishing", async () => {
    const fake = setup();
    const preview = await fake.service.run({
      dryRun: true,
      selection: { reviewIds: [fake.review.reviewId] },
    });
    expect(preview.items[0]).toMatchObject({
      status: "recoverable",
      codes: [],
      operationId: fake.task.input.operationId,
      candidateSummary: { status: "candidate" },
    });
    expect(fake.results.stageReviewed).not.toHaveBeenCalled();
    expect(fake.records.size).toBe(0);
    expect(fake.objects.create).not.toHaveBeenCalled();
  });

  it("publishes the previewed vision result and retains the original Review", async () => {
    const fake = setup();
    const preview = await fake.service.run({
      dryRun: true,
      selection: { reviewIds: [fake.review.reviewId] },
    });
    const result = await fake.service.run({ dryRun: false, previewId: preview.previewId });
    expect(result.items[0]).toMatchObject({
      status: "recovered",
      superseded: true,
      operationId: fake.task.input.operationId,
    });
    expect(fake.results.stageReviewed).toHaveBeenCalledExactlyOnceWith(
      fake.task,
      expect.any(AbortSignal),
    );
    expect(fake.records.has(fake.task.input.operationId)).toBe(true);
    expect(await fake.reviews.read()).toEqual(fake.review);
    await fake.service.run({ dryRun: false, previewId: preview.previewId });
    expect(fake.results.stageReviewed).toHaveBeenCalledOnce();
  });

  it("does not promise a vision recovery when its ledger cannot record one", async () => {
    const fake = setup();
    delete fake.ledger.supportsVision;
    const preview = await fake.service.run({
      dryRun: true,
      selection: { reviewIds: [fake.review.reviewId] },
    });
    expect(preview.items[0]).toMatchObject({
      status: "unavailable",
      codes: ["RECHECK.PUBLICATION_UNVERIFIED"],
    });
    expect(fake.results.stageReviewed).not.toHaveBeenCalled();
  });
});
