import { isDeepStrictEqual } from "node:util";
import { isAppError, type AppError, type ObjectStore } from "@crawl-automation/platform";
import {
  ReviewRecordSchema,
  type ArtifactRef,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import type { ProcessingInput, ResultFacts, StoredRecord } from "../results/result-kind.js";
import { appendConfirmed, keepAndRecordReview, type ReviewLedger } from "./kept-review.js";
import { buildStepReview, newReviewId } from "./step-review.js";

export type ReceiptFailureReason =
  | "identityConflict"
  | "reviewUnverified"
  | "resultUnconfirmed"
  | "evidenceUnverified"
  | "localUnverified";

/** What a processing step reported: a result, or a Review. */
export type StepOutcome =
  | {
      status: "registered" | "uploaded";
      operationId: string;
      result: ArtifactRef;
      completion: ArtifactRef;
    }
  | { status: "review"; operationId: string; reviewId: string; code: string; evidenceKey?: string };
type ReviewOutcome = Extract<StepOutcome, { status: "review" }>;

/** How one kind of receipt names and checks its records (Strategy). */
export interface ReceiptKind<TInput extends ProcessingInput, TRecord, TReceipt> {
  parseRequest(raw: unknown): { input: TInput; outcome: StepOutcome | null };
  parseRecord(raw: unknown): TRecord;
  /** The stage whose Reviews this receipt confirms. */
  reviewedStage: string;
  observation(input: TInput): unknown;
  /** Checks a Review must also pass to be this task's, beyond ID, operation, stage, code and observation. */
  ownsReview(review: ReviewRecord, input: TInput, outcome: ReviewOutcome): boolean;
  reviewReceipt(input: TInput, review: ReviewRecord): TReceipt;
  registeredReceipt(registration: TRecord): TReceipt;
  /** The receipt's own Review of a failure it could not settle. */
  failureReview: { stage: string; idPrefix: string; keyPrefix: string; errorName: string };
  failureDetails(input: TInput, outcome: StepOutcome | null): Record<string, unknown>;
  failureInspection(input: TInput): unknown;
  codes: Record<ReceiptFailureReason, string>;
  fail(reason: ReceiptFailureReason): AppError;
}

export interface ReceiptDeps<TInput, TRecord> {
  results: {
    inspect(input: TInput, signal: AbortSignal): Promise<ResultFacts<TRecord>>;
    /** Cloud mode: registers what a ledger-less worker left in R2. */
    registerFromRemote?(input: unknown, signal: AbortSignal): Promise<unknown>;
  };
  local: ObjectStore;
  reviews: ReviewLedger;
  /** Cloud mode: Reviews a ledger-less worker kept remotely; registered here only after identity checks. */
  remoteReviews?: { read(id: string): Promise<ReviewRecord | null> };
}

const KEPT: readonly ReceiptFailureReason[] = [
  "identityConflict",
  "reviewUnverified",
  "resultUnconfirmed",
];

/** Confirms a step's result or Review. Never runs the service, uploads or retries; unknown means inspect only. */
export class ProcessingReceipt<
  TInput extends ProcessingInput,
  TRecord extends StoredRecord<TInput>,
  TReceipt,
> {
  constructor(
    private readonly kind: ReceiptKind<TInput, TRecord, TReceipt>,
    private readonly deps: ReceiptDeps<TInput, TRecord>,
  ) {}

  async run(raw: unknown, signal: AbortSignal): Promise<TReceipt> {
    const { input, outcome } = this.kind.parseRequest(raw);
    try {
      signal.throwIfAborted();
      if (outcome && outcome.operationId !== input.operationId) {
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
    if (!isDeepStrictEqual(registration.input, input) || !sameFiles(outcome, registration)) {
      throw this.kind.fail("identityConflict");
    }
    return this.kind.registeredReceipt(registration);
  }

  private ownReview(raw: unknown, input: TInput, outcome: ReviewOutcome): ReviewRecord {
    const review = ReviewRecordSchema.parse(raw);
    const { failure } = review;
    const matches =
      review.reviewId === outcome.reviewId &&
      failure.operationId === input.operationId &&
      failure.inputFingerprint === input.inputFingerprint &&
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
      task: input,
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
function sameFiles(outcome: StepOutcome | null, registration: StoredRecord<unknown>): boolean {
  if (outcome?.status !== "registered" && outcome?.status !== "uploaded") {
    return true;
  }
  return (
    isDeepStrictEqual(outcome.result, registration.result) &&
    isDeepStrictEqual(outcome.completion, registration.completion)
  );
}
