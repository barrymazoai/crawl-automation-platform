import { z } from "zod";
import { sha256 } from "@crawl-automation/platform";
import {
  LabelProductJoinSchema,
  ReviewRecordSchema,
  type LabelProductJoin,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { mergeLabelProduct } from "../assembly/label-merge.js";
import { encodeJson } from "../results/result-record.js";
import { sourceReviewFailure } from "../assembly/source-review.js";
import { extractPackagingFacts } from "../assembly/packaging.js";
import { visionTaskFingerprint } from "../vision/vision-files.js";
import { RecheckTextSource } from "./text-source.js";
import { RecheckImageSource } from "./image-source.js";
import { RecheckPreparation } from "./preparation.js";
import { recheckErrors } from "./errors.js";
import { assertRecheckIdentity, recheckDigest } from "./verified-files.js";
import { RECHECK_RULES, type SavedAnswerDeps, type RecheckedSource } from "./types.js";

const SavedInput = z.object({ input: LabelProductJoinSchema });

/** Only a product assembly/collection Review carries the complete source barrier. */
export function reviewedJoin(review: ReviewRecord): LabelProductJoin {
  if (!["product.label.assembly", "product.label.collect"].includes(review.failure.stage)) {
    throw recheckErrors.create("RECHECK.UNSUPPORTED_REVIEW");
  }
  const candidate = SavedInput.safeParse(review.candidate?.value);
  const input = candidate.success
    ? candidate.data.input
    : SavedInput.parse(review.rawError.details).input;
  assertRecheckIdentity(input.manifest.observation, review.observation);
  assertRecheckIdentity(input.manifest.operationId, review.failure.operationId);
  assertRecheckIdentity(sha256(encodeJson(input)), review.failure.inputFingerprint);
  const ids = input.states.map((state) => state.id);
  assertRecheckIdentity([...ids].sort(), input.manifest.sources.map((source) => source.id).sort());
  if (new Set(ids).size !== ids.length) {
    throw recheckErrors.create("RECHECK.IDENTITY_CONFLICT");
  }
  return input;
}

/** Reads and recomputes only. A missing source fails closed, even if another source looks complete. */
export class SavedLabelRecheck {
  constructor(private readonly deps: SavedAnswerDeps) {}

  async check(raw: ReviewRecord, signal: AbortSignal) {
    const review = ReviewRecordSchema.parse(raw);
    const original = reviewedJoin(review);
    const sources: RecheckedSource[] = [];
    for (const source of original.manifest.sources) {
      signal.throwIfAborted();
      const state = original.states.find((item) => item.id === source.id);
      if (!state || !["registered", "review"].includes(state.status)) {
        throw recheckErrors.create("RECHECK.RECEIPT_UNVERIFIED");
      }
      const failed =
        state.status === "review"
          ? await this.sourceReview(original, source, state.reviewId)
          : null;
      sources.push(
        source.kind === "text"
          ? await new RecheckTextSource(this.deps).read(source, failed, signal)
          : await new RecheckImageSource(this.deps).read(source, failed, signal),
      );
    }
    const manifest = { ...original.manifest, evidencePolicy: "label-image-first/6" as const };
    const packaging = await this.packaging(original, signal);
    const entries = sources.flatMap((source) => (source.entry ? [source.entry] : []));
    const failures = sources.flatMap((source) => (source.failure ? [source.failure] : []));
    const result = mergeLabelProduct(manifest, { entries, failures }, packaging);
    return {
      rules: RECHECK_RULES,
      original,
      originalReviewId: review.reviewId,
      originalReviewHash: recheckDigest(review),
      result,
      receipts: sources.map((source) => source.receipt),
      files: sources.flatMap((source) => source.files),
    };
  }

  private async sourceReview(
    input: LabelProductJoin,
    source: LabelProductJoin["manifest"]["sources"][number],
    reviewId: string,
  ) {
    const review = await this.deps.reviews.read(reviewId);
    const reader = {
      reviews: { read: async () => review },
      visionFingerprint: visionTaskFingerprint,
    };
    const failure = await sourceReviewFailure(reader, source, { input, reviewId });
    if (!failure.verifiedExecuted || !review) {
      throw recheckErrors.create("RECHECK.RECEIPT_UNVERIFIED");
    }
    return review;
  }

  private async packaging(input: LabelProductJoin, signal: AbortSignal) {
    const { observation, admission } = input.manifest;
    if (!admission) {
      return undefined;
    }
    const preparation = new RecheckPreparation(this.deps);
    const documents = [];
    for (const ref of admission.documents) {
      documents.push(await preparation.document(ref, observation, signal));
    }
    return extractPackagingFacts(observation, documents);
  }
}

export type RecheckedLabel = Awaited<ReturnType<SavedLabelRecheck["check"]>>;
