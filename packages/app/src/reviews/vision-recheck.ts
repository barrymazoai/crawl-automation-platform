import { errorCodeOf, recordRecovery, type ObjectStore } from "@crawl-automation/platform";
import { retainedVisionReviewAnswer } from "@crawl-automation/processing";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import {
  recheckResult,
  retainedReviewKind,
  type RecheckOutcome,
  type RecheckResult,
} from "./retained-answer.js";

/** Current vision rules against the exact saved answer; no model or result writes. */
export class VisionAnswerRecheck {
  constructor(private readonly objects: Pick<ObjectStore, "read">) {}

  async check(review: ReviewRecord, signal: AbortSignal): Promise<RecheckResult> {
    if (retainedReviewKind(review) !== "vision") {
      return recheckResult(review, {
        status: "not_applicable",
        code: null,
        reason: "no retained label vision answer",
      });
    }
    try {
      const answer = await retainedVisionReviewAnswer(review, this.objects, signal);
      return recheckResult(review, {
        status: answer.decoded.status === "review" ? "fails" : "passes",
        code: answer.decoded.code,
        reason: null,
      });
    } catch (error) {
      signal.throwIfAborted();
      recordRecovery(error, {
        operation: "vision.recheck",
        operationId: review.failure.operationId,
      });
      return recheckResult(review, failedVisionAnswer(error));
    }
  }
}

function failedVisionAnswer(error: unknown): RecheckOutcome {
  const code = errorCodeOf(error);
  const unavailable = code?.startsWith("RECHECK.") || code?.startsWith("STORAGE.");
  return {
    status: unavailable ? "unavailable" : "fails",
    code: code ?? "VISION.INVALID_OUTPUT",
    reason: unavailable ? "retained vision evidence unavailable" : null,
  };
}
