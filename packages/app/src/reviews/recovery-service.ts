import { randomUUID } from "node:crypto";
import { recordRecovery } from "@crawl-automation/platform";
import {
  recheckCode,
  recheckDigest,
  recheckedLabelDigest,
  recheckErrors,
  recoveredCollection,
  assemblyFailure,
  type RecheckedLabel,
} from "@crawl-automation/processing";
import type { ReviewRecord, VisionTask } from "@crawl-automation/v3-contracts";
import { ReviewPageSchema } from "./review-model.js";
import { readReviewRecord, retainedReviewKind } from "./retained-answer.js";
import {
  ReviewRecoveryInputSchema,
  type RecoveryItem,
  type RecoveryPreview,
  type ReviewRecoveryInput,
} from "./recovery-model.js";
import type { ReviewRecoveryDeps } from "./recovery-ports.js";
import { publishRecoveryFiles } from "./recovery-publication.js";
import { evaluateVisionRecovery } from "./vision-recovery.js";

/** Manual, bounded retained-evidence recovery. Preview persists an audit report only, never product artifacts. */
export class ReviewRecoveryService {
  constructor(private readonly deps: ReviewRecoveryDeps) {}

  async run(raw: ReviewRecoveryInput) {
    const input = ReviewRecoveryInputSchema.parse(raw);
    return input.dryRun ? this.preview(input.selection) : this.apply(input.previewId);
  }

  status(reviewId: string) {
    return this.deps.ledger.status(reviewId);
  }

  private async selected(selection: Extract<ReviewRecoveryInput, { dryRun: true }>["selection"]) {
    if ("reviewIds" in selection) {
      return selection.reviewIds;
    }
    const page = ReviewPageSchema.parse(
      await this.deps.reviews.list({ ...selection.filter, limit: selection.limit }),
    );
    return page.items.slice(0, selection.limit).map((item) => item.reviewId);
  }

  private async preview(selection: Extract<ReviewRecoveryInput, { dryRun: true }>["selection"]) {
    const signal = AbortSignal.timeout(120_000);
    const items: RecoveryItem[] = [];
    for (const id of await this.selected(selection)) {
      items.push((await this.evaluate(id, signal)).item);
    }
    const now = Date.now();
    const preview: RecoveryPreview = {
      previewId: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30 * 60_000).toISOString(),
      items,
    };
    await this.deps.ledger.savePreview(preview);
    return { dryRun: true, ...preview, summary: summarize(items) };
  }

  private async evaluate(
    reviewId: string,
    signal: AbortSignal,
  ): Promise<{ item: RecoveryItem; label?: RecheckedLabel; visionTask?: VisionTask }> {
    const review = await readReviewRecord(this.deps.reviews, reviewId);
    const base = { reviewId, originalReviewHash: recheckDigest(review), operationId: null };
    try {
      if (retainedReviewKind(review) === "vision") {
        return await evaluateVisionRecovery(review, this.deps, signal);
      }
      return await this.evaluateLabel(review, base, signal);
    } catch (error) {
      recordRecovery(error, { operation: "reviews.recover.preview", reviewId });
      signal.throwIfAborted();
      return {
        item: { ...base, status: "unavailable", codes: [recheckCode(error)], digest: null },
      };
    }
  }

  private async evaluateLabel(
    review: ReviewRecord,
    base: Pick<RecoveryItem, "reviewId" | "originalReviewHash" | "operationId">,
    signal: AbortSignal,
  ) {
    const label = await this.deps.recheck.check(review, signal);
    const collection = label.result.status === "ready" ? recoveredCollection(label) : null;
    if (collection) {
      const existing = await this.deps.ledger.collectionFor(
        collection.record.observation.observationId,
      );
      if (existing && existing.operationId !== collection.record.operationId) {
        throw assemblyFailure("LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED");
      }
    }
    const item: RecoveryItem = {
      ...base,
      digest: recheckedLabelDigest(label),
      operationId: collection?.record.operationId ?? null,
      status: collection ? "recoverable" : "review",
      codes: label.result.codes,
    };
    return { label, item };
  }

  private async apply(previewId: string) {
    const preview = await this.deps.ledger.readPreview(previewId);
    if (!preview || Date.parse(preview.expiresAt) <= Date.now()) {
      throw recheckErrors.create("RECHECK.PREVIEW_REQUIRED");
    }
    const signal = AbortSignal.timeout(120_000);
    const items = [];
    for (const expected of preview.items) {
      items.push(await this.applyItem({ previewId, expected }, signal));
    }
    return { dryRun: false, previewId, items, summary: summarize(items) };
  }

  private async applyItem(at: { previewId: string; expected: RecoveryItem }, signal: AbortSignal) {
    const { previewId, expected } = at;
    const prior = await this.deps.ledger.status(expected.reviewId);
    if (prior?.superseded) {
      return prior;
    }
    const actual = await this.evaluate(expected.reviewId, signal);
    if (recheckDigest(actual.item) !== recheckDigest(expected)) {
      throw recheckErrors.create("RECHECK.PREVIEW_CHANGED", {
        details: { reviewId: expected.reviewId },
      });
    }
    return this.publishEvaluated(previewId, actual, signal);
  }

  private async publishEvaluated(
    previewId: string,
    actual: { item: RecoveryItem; label?: RecheckedLabel; visionTask?: VisionTask },
    signal: AbortSignal,
  ) {
    const collection =
      actual.label?.result.status === "ready" ? recoveredCollection(actual.label) : null;
    const vision = actual.visionTask ? await this.stageVision(actual.visionTask, signal) : null;
    if (collection) {
      await publishRecoveryFiles(this.deps.objects, collection.files, signal);
    }
    signal.throwIfAborted();
    return this.deps.ledger.record({
      previewId,
      item: actual.item,
      collection: collection?.record ?? null,
      ...(vision ? { vision } : {}),
    });
  }

  private stageVision(task: VisionTask, signal: AbortSignal) {
    if (!this.deps.vision || !this.deps.ledger.supportsVision) {
      throw recheckErrors.create("RECHECK.PUBLICATION_UNVERIFIED");
    }
    return this.deps.vision.results.stageReviewed(task, signal);
  }
}

function summarize(items: RecoveryItem[]) {
  const counts = { recoverable: 0, recovered: 0, review: 0, unavailable: 0 };
  for (const item of items) {
    counts[item.status]++;
  }
  return counts;
}
