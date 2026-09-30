import { recordRecovery } from "@crawl-automation/platform";
import { pipelineErrors } from "@crawl-automation/platform";
import { LabelPlanInputSchema, type LabelPlanInput } from "@crawl-automation/processing";
import { sha256 } from "@crawl-automation/platform";
import { ReviewRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { appErrors } from "../errors.js";
import type { ProductReview } from "./product-reviews.js";
import type { EvidencePublisher, ReviewLedger } from "./ports.js";

/** A label product without usable sources, with unverified preparation, or held up by permits. */
export const LabelReviewRequestSchema = z.strictObject({
  input: z.unknown(),
  code: z.enum([
    "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
    "CHANNEL.LABEL_NO_SOURCE",
    pipelineErrors.code("CHANNEL.DEPENDENCY_UNAVAILABLE"),
  ]),
  states: z.array(z.unknown()).max(100),
  failures: z
    .array(z.strictObject({ sourceId: z.string(), code: z.string(), executionFact: z.string() }))
    .max(100)
    .optional(),
});

/**
 * The label product's own Review, one per label task: kept as evidence, then appended to the ledger and read back.
 * It records every source's state and what held each one up; it is never retried automatically.
 */
export class LabelReviews {
  constructor(private readonly deps: { evidence: EvidencePublisher; reviews: ReviewLedger }) {}

  async review(raw: unknown, signal: AbortSignal): Promise<ProductReview> {
    const request = LabelReviewRequestSchema.parse(raw);
    const input = LabelPlanInputSchema.parse(request.input);
    const fingerprint = sha256(Buffer.from(JSON.stringify(input)));
    const reviewId = `chl-review-${fingerprint}`;
    const evidenceKey = `v3/channel-labels/${input.operationId}/review.json`;
    const prior = await this.deps.reviews.read(reviewId);
    if (prior) {
      return this.receipt({ input, reviewId, evidenceKey }, prior.failure.code);
    }
    const record = labelReview({ input, request, fingerprint, reviewId, evidenceKey });
    await this.deps.evidence.publish(
      evidenceKey,
      Buffer.from(JSON.stringify(record)),
      "application/json",
      signal,
    );
    try {
      await this.deps.reviews.append(record);
    } catch (error) {
      recordRecovery(error, { operation: "pipeline/label-reviews" });
      // The read-back below decides.
    }
    const saved = await this.deps.reviews.read(reviewId);
    if (!saved) {
      throw appErrors.create("PIPELINE.REVIEW_UNVERIFIED", { details: { reviewId } });
    }
    return this.receipt({ input, reviewId, evidenceKey }, saved.failure.code);
  }

  private receipt(
    at: { input: LabelPlanInput; reviewId: string; evidenceKey: string },
    code: string,
  ): ProductReview {
    const { input, reviewId, evidenceKey } = at;
    return {
      status: "review",
      operationId: input.operationId,
      reviewId,
      code,
      evidenceKey,
      automaticRetry: false,
    };
  }
}

function labelReview(at: {
  input: LabelPlanInput;
  request: z.infer<typeof LabelReviewRequestSchema>;
  fingerprint: string;
  reviewId: string;
  evidenceKey: string;
}): ReviewRecord {
  const { input, request } = at;
  const owner = input.owner;
  const details = {
    input,
    states: request.states,
    ...(request.failures ? { failures: request.failures } : {}),
  };
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: at.reviewId,
    occurredAt: new Date().toISOString(),
    observation: owner,
    failure: {
      schemaVersion: 1,
      requestId: owner.requestId,
      observationId: owner.observationId,
      operationId: input.operationId,
      inputFingerprint: at.fingerprint,
      stage: "channel.label-input",
      category: "PROCESSING",
      code: request.code,
      executionFact: "unknown",
      evidenceKey: at.evidenceKey,
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: { name: "ChannelLabelFailure", message: request.code, stack: null, details },
    candidate: null,
    inspection: { kind: "none" },
  });
}
