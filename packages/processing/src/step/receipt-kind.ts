import { isDeepStrictEqual } from "node:util";
import type { AppError, ObjectStore } from "@crawl-automation/platform";
import type { ArtifactRef, ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ResultFacts } from "../results/result-kind.js";
import type { ReviewLedger } from "./kept-review.js";
import type { ReviewedTask } from "./step-review.js";

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
export type ReviewOutcome = Extract<StepOutcome, { status: "review" }>;

/** A registration's two result files. */
export interface ReceiptRecord {
  result: ArtifactRef;
  completion: ArtifactRef;
}

/** How one kind of receipt names and checks its records (Strategy). */
export interface ReceiptKind<TInput, TRecord extends ReceiptRecord, TReceipt> {
  parseRequest(raw: unknown): { input: TInput; outcome: StepOutcome | null };
  parseRecord(raw: unknown): TRecord;
  /** The identity Reviews of this task carry. */
  task(input: TInput): ReviewedTask;
  /** The registration is exactly this task's. */
  ownsRegistration(registration: TRecord, input: TInput): boolean;
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

/** For kinds whose registration stores the task itself as its `input` (text, OCR). */
export const registeredInputIs = (registration: { input: unknown }, input: unknown) =>
  isDeepStrictEqual(registration.input, input);

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
