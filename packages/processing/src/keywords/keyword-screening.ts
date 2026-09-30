import { recordRecovery } from "@crawl-automation/platform";
import { isAppError, type ObjectStore } from "@crawl-automation/platform";
import {
  DefaultKeywordPolicy,
  KeywordReceiptSchema,
  KeywordResultSchema,
  OcrRegistrationSchema,
  observationIdentity,
  type KeywordReceipt,
  type KeywordResult,
} from "@crawl-automation/v3-contracts";
import { publishOnce } from "../results/publish-once.js";
import { encodeJson, hashString } from "../results/result-record.js";
import { keepAndRecordReview, type ReviewLedger } from "../step/kept-review.js";
import { buildStepReview, newReviewId } from "../step/step-review.js";
import { keywordFailure, type KeywordErrorCode } from "./keyword-errors.js";
import type { LedgerOcrText } from "./ocr-text.js";

/** Names the keyword policy in a Review's operation ID, so a policy change is a different operation. */
export const keywordCompatibility = `keywords-${hashString(JSON.stringify(DefaultKeywordPolicy)).slice(0, 32)}`;
export const keywordKey = (result: KeywordResult) =>
  `v3/keywords/${result.ocrOperationId}/${result.policyFingerprint}.json`;

const MAX_DECISION_BYTES = 1024 * 1024;
const KEPT: readonly KeywordErrorCode[] = [
  "SCREEN.UPSTREAM_UNVERIFIED",
  "SCREEN.SOURCE_CONFLICT",
  "SCREEN.EVIDENCE_MISMATCH",
  "SCREEN.PUBLICATION_CONFLICT",
  "SCREEN.HANDOFF_PENDING",
];

export interface KeywordScreeningDeps {
  text: Pick<LedgerOcrText, "screen">;
  local: ObjectStore;
  remote: ObjectStore;
  reviews: ReviewLedger;
}

export interface KeywordReview {
  status: "review";
  code: string;
  reviewId: string;
  automaticRetry: false;
}

/**
 * Keyword screening of one registered OCR result: the decision is published once as evidence; any failure becomes a
 * Review. Nothing is retried.
 */
export class KeywordScreening {
  constructor(private readonly deps: KeywordScreeningDeps) {}

  async run(raw: unknown, signal: AbortSignal): Promise<KeywordReceipt | KeywordReview> {
    try {
      const result = await this.deps.text.screen(raw, signal);
      const evidenceKey = await this.publish(result, signal);
      const imageId = result.image.artifactId;
      return KeywordReceiptSchema.parse({
        status: result.status,
        imageId,
        selection: result,
        evidenceKey,
      });
    } catch (error) {
      recordRecovery(error, { operation: "keyword-screening" });
      const own = isAppError(error) && (KEPT as readonly string[]).includes(error.code);
      const code = own ? error.code : "SCREEN.EVIDENCE_UNRESOLVED";
      const reviewId = await this.recordReview(raw, code);
      return { status: "review", code, reviewId, automaticRetry: false };
    }
  }

  /** Only a decision computed from verified OCR is published; an existing decision is never written again. */
  private async publish(raw: KeywordResult, signal: AbortSignal): Promise<string> {
    const result = KeywordResultSchema.parse(raw);
    const key = keywordKey(result);
    await publishOnce(
      this.deps,
      { key, bytes: encodeJson(result), limit: MAX_DECISION_BYTES },
      {
        signal,
        mismatch: () => keywordFailure("SCREEN.PUBLICATION_CONFLICT"),
        pending: () => keywordFailure("SCREEN.HANDOFF_PENDING"),
      },
    );
    return key;
  }

  private async recordReview(raw: unknown, code: string): Promise<string> {
    const registration = OcrRegistrationSchema.parse(raw);
    const { input } = registration;
    const reviewId = newReviewId("screen");
    const review = buildStepReview({
      reviewId,
      task: {
        requestId: input.requestId,
        observationId: input.observationId,
        operationId: `screen-${hashString(JSON.stringify([input.operationId, keywordCompatibility]))}`,
        inputFingerprint: hashString(JSON.stringify(registration)),
      },
      observation: observationIdentity(input),
      stage: "ocr.keywords",
      category: "PROCESSING",
      code,
      fact: "unknown",
      evidenceKey: registration.result.objectKey,
      blockedBy: null,
      error: { name: "KeywordStageError", details: { registration } },
      candidate: null,
      inspection: { kind: "none" },
    });
    const unverified = () => keywordFailure("SCREEN.REVIEW_UNVERIFIED");
    const place = {
      local: this.deps.local,
      key: `keyword-reviews/${reviewId}.json`,
      reviews: this.deps.reviews,
    };
    await keepAndRecordReview(review, place, {
      localUnverified: unverified,
      reviewUnverified: unverified,
    });
    return reviewId;
  }
}
