import { isDeepStrictEqual } from "node:util";
import { isAppError, type AppError } from "@crawl-automation/platform";
import { ReviewRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { appendConfirmed, keepAndRecordReview } from "./kept-review.js";
import type {
  ReceiptDeps,
  ReceiptFailureReason,
  ReceiptKind,
  ReceiptRecord,
  ReviewOutcome,
  StepOutcome,
} from "./receipt-kind.js";
import { buildStepReview, newReviewId } from "./step-review.js";

export * from "./receipt-kind.js";

const KEPT: readonly ReceiptFailureReason[] = [
  "identityConflict",
  "reviewUnverified",
  "resultUnconfirmed",
];

/** Confirms a step's result or Review. Never runs the service, uploads or retries; unknown means inspect only. */
export class ProcessingReceipt<TInput, TRecord extends ReceiptRecord, TReceipt> {
  constructor(
    private readonly kind: ReceiptKind<TInput, TRecord, TReceipt>,
    private readonly deps: ReceiptDeps<TInput, TRecord>,
  ) {}

  async run(raw: unknown, signal: AbortSignal): Promise<TReceipt> {
    const { input, outcome } = this.kind.parseRequest(raw);
    try {
      signal.throwIfAborted();
      if (outcome && outcome.operationId !== this.kind.task(input).operationId) {
        throw this.kind.fail("identityConflict");
      }
      if (outcome?.status === "review") {
        return this.kind.reviewReceipt(input, await this.confirmedReview(input, outcome));
      }
      return await this.confirmedResult(input, outcome, signal);
    } catch (error) {
      return this.kind.reviewReceipt(input, await this.recordFailure({ input, outcome, error }));
    }
  }

  /** An explicit Review is never promoted to success; a cloud Review enters the ledger only as this task's. */
  private async confirmedReview(input: TInput, outcome: ReviewOutcome): Promise<ReviewRecord> {
    const own = (raw: unknown) => this.ownReview(raw, input, outcome);
    const saved = await this.deps.reviews.read(outcome.reviewId);
    if (saved) {
      return own(saved);
    }
    const retained = await this.deps.remoteReviews?.read(outcome.reviewId);
    if (!retained) {
      throw this.kind.fail("reviewUnverified");
    }
    return appendConfirmed(this.deps.reviews, own(retained), () =>
      this.kind.fail("reviewUnverified"),
    );
  }

  private async confirmedResult(input: TInput, outcome: StepOutcome | null, signal: AbortSignal) {
    const { results } = this.deps;
    if (outcome?.status === "uploaded") {
      // Cloud mode: durable but unregistered; rebuilt and verified from the R2 files, then registered here.
      if (!results.registerFromRemote) {
        throw this.kind.fail("resultUnconfirmed");
      }
      await results.registerFromRemote(input, signal);
    }
    const facts = await results.inspect(input, signal);
    if (!facts.resultRegistered || !facts.artifactDurable || !facts.record) {
      throw this.kind.fail("resultUnconfirmed");
    }
    const registration = this.kind.parseRecord(facts.record);
    if (!this.kind.ownsRegistration(registration, input) || !sameFiles(outcome, registration)) {
      throw this.kind.fail("identityConflict");
    }
    return this.kind.registeredReceipt(registration);
  }

  private ownReview(raw: unknown, input: TInput, outcome: ReviewOutcome): ReviewRecord {
    const review = ReviewRecordSchema.parse(raw);
    const { failure } = review;
    const task = this.kind.task(input);
    const matches =
      review.reviewId === outcome.reviewId &&
      failure.operationId === task.operationId &&
      failure.inputFingerprint === task.inputFingerprint &&
      failure.stage === this.kind.reviewedStage &&
      failure.code === outcome.code &&
      isDeepStrictEqual(review.observation, this.kind.observation(input)) &&
      this.kind.ownsReview(review, input, outcome);
    if (!matches) {
      throw this.kind.fail("identityConflict");
    }
    return review;
  }

  /** The receipt's own Review: its own codes are kept; any other failure is "evidence unverified". */
  private async recordFailure(failure: {
    input: TInput;
    outcome: StepOutcome | null;
    error: unknown;
  }): Promise<ReviewRecord> {
    const { kind } = this;
    const { input } = failure;
    const kept = KEPT.map((reason) => kind.codes[reason]);
    const own = isAppError(failure.error) && kept.includes(failure.error.code);
    const code = own ? (failure.error as AppError).code : kind.codes.evidenceUnverified;
    const reviewId = newReviewId(kind.failureReview.idPrefix);
    const key = `${kind.failureReview.keyPrefix}/${reviewId}.json`;
    const review = buildStepReview({
      reviewId,
      task: kind.task(input),
      observation: kind.observation(input),
      stage: kind.failureReview.stage,
      category: "PROCESSING",
      code,
      fact: "unknown",
      evidenceKey: key,
      blockedBy: null,
      error: {
        name: kind.failureReview.errorName,
        details: kind.failureDetails(input, failure.outcome),
      },
      candidate: null,
      inspection: kind.failureInspection(input),
    });
    await keepAndRecordReview(
      review,
      { local: this.deps.local, key, reviews: this.deps.reviews },
      {
        localUnverified: () => kind.fail("localUnverified"),
        reviewUnverified: () => kind.fail("reviewUnverified"),
      },
    );
    return review;
  }
}

/** The ledger's result files are the ones the step reported, when it reported any. */
function sameFiles(outcome: StepOutcome | null, registration: ReceiptRecord): boolean {
  if (outcome?.status !== "registered" && outcome?.status !== "uploaded") {
    return true;
  }
  return (
    isDeepStrictEqual(outcome.result, registration.result) &&
    isDeepStrictEqual(outcome.completion, registration.completion)
  );
}
