import { recordRecovery } from "@crawl-automation/platform";
import { isDeepStrictEqual } from "node:util";
import { errorCodeOf } from "@crawl-automation/platform";
import {
  ReviewRecordSchema,
  type ChannelPlanInput,
  type ChannelPlanOutcome,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { PLAN_LIMIT, decodeJson, encodeJson, planFingerprint } from "./plan-codec.js";
import { planErrors } from "./plan-errors.js";
import type { PlanPublication, PlanReviews } from "./plan-ports.js";

const STAGE = "channel.product-input";
/** Channel parser codes are kept as the Review code; anything else is recorded as unresolved. */
const KNOWN_CODE = /^(CHANNEL|SWANSON|AMAZON|DTC|GNC|ARTIFACT)\.[A-Z_]+$/;

export const planReviewId = (input: ChannelPlanInput) => `chp-${planFingerprint(input)}`;
const reviewKey = (reviewId: string) => `v3/channel-plan-reviews/${reviewId}.json`;

/** The code a planning failure is recorded under. */
export function planFailureCode(error: unknown, cancelled: boolean): string {
  if (cancelled) {
    return "CHANNEL.CANCELLED";
  }
  const code = errorCodeOf(error);
  return code && KNOWN_CODE.test(code) ? code : "CHANNEL.PLAN_UNRESOLVED";
}

function categoryOf(code: string) {
  return code.startsWith("ARTIFACT.") || code === "CHANNEL.NOT_DURABLE" ? "ARTIFACT" : "PROCESSING";
}

function proposedReview(input: ChannelPlanInput, code: string): ReviewRecord {
  const reviewId = planReviewId(input);
  const { owner } = input;
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId,
    occurredAt: new Date().toISOString(),
    observation: owner,
    failure: {
      schemaVersion: 1,
      requestId: owner.requestId,
      observationId: owner.observationId,
      operationId: input.operationId,
      inputFingerprint: planFingerprint(input),
      stage: STAGE,
      category: categoryOf(code),
      code,
      executionFact: "unknown",
      evidenceKey: reviewKey(reviewId),
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: { name: "ChannelPlanFailure", message: code, stack: null, details: { input } },
    candidate: null,
    inspection: { kind: "none" },
  });
}

/** A passive planning Review: written once to the local store, appended to the ledger, then read back exactly. */
export class PlanReviewLedger {
  constructor(
    private readonly reviews: PlanReviews,
    private readonly publication: PlanPublication,
  ) {}

  /** The Review already recorded for this plan input; it is never replayed. */
  async prior(input: ChannelPlanInput): Promise<ChannelPlanOutcome | null> {
    const reviewId = planReviewId(input);
    const raw = await this.reviews.read(reviewId);
    if (!raw) {
      return null;
    }
    const record = ReviewRecordSchema.parse(raw);
    if (!this.matches(record, input)) {
      throw planErrors.create("CHANNEL.REVIEW_UNVERIFIED");
    }
    const { code, evidenceKey } = record.failure;
    const operationId = input.operationId;
    return { status: "review", operationId, reviewId, evidenceKey, code, automaticRetry: false };
  }

  async record(input: ChannelPlanInput, code: string): Promise<ChannelPlanOutcome> {
    const proposed = proposedReview(input, code);
    const keep = AbortSignal.timeout(10_000);
    const key = proposed.failure.evidenceKey;
    await this.publication.local.create(key, encodeJson(proposed), "application/json", keep);
    const saved = await this.publication.local.read(key, PLAN_LIMIT, keep);
    const record = saved ? ReviewRecordSchema.parse(decodeJson(saved)) : null;
    if (!record || !this.matches(record, input)) {
      throw planErrors.create("CHANNEL.REVIEW_UNVERIFIED");
    }
    // A lost acknowledgement is settled by reading the same ID back, never by a second append.
    await this.reviews.append(record).catch((error: unknown) => {
      recordRecovery(error, { operation: "plan.review", reviewId: record.reviewId });
    });
    if (!isDeepStrictEqual(await this.reviews.read(record.reviewId), record)) {
      throw planErrors.create("CHANNEL.REVIEW_UNVERIFIED");
    }
    const outcome = await this.prior(input);
    if (!outcome) {
      throw planErrors.create("CHANNEL.REVIEW_UNVERIFIED");
    }
    return outcome;
  }

  private matches(record: ReviewRecord, input: ChannelPlanInput): boolean {
    const reviewId = planReviewId(input);
    const { failure } = record;
    return (
      record.reviewId === reviewId &&
      isDeepStrictEqual(record.observation, input.owner) &&
      failure.operationId === input.operationId &&
      failure.inputFingerprint === planFingerprint(input) &&
      failure.stage === STAGE &&
      failure.evidenceKey === reviewKey(reviewId) &&
      isDeepStrictEqual(record.rawError.details, { input })
    );
  }
}
