import type { AppError } from "@crawl-automation/platform";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import type { PrivateReviewReader, ReviewWriter } from "@crawl-automation/v3-review";
import type { ProcessingInput, ResultFacts, StoredRecord } from "../results/result-kind.js";
import type { ResultStore } from "../results/result-store.js";
import { recordStepReview } from "./step-review.js";
import type { ExecutionFact } from "./step-failure.js";

/** One run of a step: its task, whether the service has run, and what it answered (kept for a Review). */
export interface StepAttempt<TInput> {
  input: TInput;
  fact: ExecutionFact;
  candidate: { schema: string; value: unknown } | null;
}

/** Why a run failed, as it will be recorded. */
export interface StepFailure {
  error: unknown;
  code: string;
  fact: ExecutionFact;
}

export interface StepDeps<
  TInput extends ProcessingInput,
  TOutput,
  TRecord extends StoredRecord<TInput>,
> {
  results: ResultStore<TInput, TOutput, TRecord>;
  reviews: ReviewWriter & PrivateReviewReader;
  /** "register" writes the ledger; "upload-only" (cloud mode) leaves registration to the receipt step. */
  mode?: "register" | "upload-only";
}

/** How long storing a result or a Review may take after the service answered, even if the task was cancelled. */
const RETENTION_MS = 10_000;

/**
 * Every processing step (Template Method): reuse a finished result, read the evidence, claim the task once, call the
 * service once, then keep, upload and register the result. Any failure becomes a Review recording whether the
 * service ran; nothing is retried. Subclasses supply the service call and their own records.
 */
export abstract class ProcessingStep<
  TInput extends ProcessingInput,
  TOutput,
  TRecord extends StoredRecord<TInput>,
  TOutcome,
  TEvidence,
> {
  constructor(private readonly stepDeps: StepDeps<TInput, TOutput, TRecord>) {}

  /** The task, valid and for exactly the service this worker runs. */
  protected abstract admit(raw: unknown): TInput;
  /** The evidence the service reads. A failure here means the service never ran. */
  protected abstract readEvidence(input: TInput, signal: AbortSignal): Promise<TEvidence>;
  protected abstract claim(input: TInput, signal: AbortSignal): Promise<void>;
  /** The one call. Sets `attempt.fact` to "executed" as soon as the service has answered. */
  protected abstract call(
    attempt: StepAttempt<TInput>,
    evidence: TEvidence,
    signal: AbortSignal,
  ): Promise<TOutput>;
  protected abstract settled(input: TInput, record: TRecord, registered: boolean): TOutcome;
  /** The failure's code and what it says about the service having run (null: it does not say). */
  protected abstract classify(
    error: unknown,
    aborted: boolean,
  ): { code: string; fact: ExecutionFact | null };
  protected abstract review(attempt: StepAttempt<TInput>, failure: StepFailure): ReviewRecord;
  protected abstract reviewed(input: TInput, review: ReviewRecord): TOutcome;
  protected abstract fail(
    reason: "incomplete" | "unknown" | "reviewUnknown",
    fact?: ExecutionFact,
  ): AppError;

  async run(raw: unknown, signal: AbortSignal): Promise<TOutcome> {
    const attempt: StepAttempt<TInput> = {
      input: this.admit(raw),
      fact: "not_executed",
      candidate: null,
    };
    try {
      return await this.execute(attempt, signal);
    } catch (error) {
      const found = await this.finishedMeanwhile(attempt.input);
      if (found) {
        return found;
      }
      const review = this.review(
        attempt,
        this.failureOf(attempt, { error, aborted: signal.aborted }),
      );
      await recordStepReview(this.stepDeps.reviews, review, () => this.fail("reviewUnknown"));
      return this.reviewed(attempt.input, review);
    }
  }

  private async execute(attempt: StepAttempt<TInput>, signal: AbortSignal): Promise<TOutcome> {
    const { input } = attempt;
    signal.throwIfAborted();
    const previous = await this.stepDeps.results.inspect(input, signal);
    const done = this.outcome(input, previous);
    if (done) {
      return done;
    }
    if (previous.record) {
      throw this.fail("incomplete", "executed");
    }
    const evidence = await this.readEvidence(input, signal);
    attempt.fact = "unknown";
    await this.claim(input, signal);
    signal.throwIfAborted();
    const output = await this.call(attempt, evidence, signal);
    return this.storeAndRegister(input, output, signal);
  }

  /** Keeps the output (even after a late cancellation), uploads it, and registers it unless in cloud mode. */
  private async storeAndRegister(input: TInput, output: TOutput, signal: AbortSignal) {
    const { results } = this.stepDeps;
    await results.capture(input, output, AbortSignal.timeout(RETENTION_MS));
    signal.throwIfAborted();
    await results.uploadMissing(input, signal);
    const facts = this.uploadOnly
      ? await results.inspect(input, signal)
      : await results.register(input, signal);
    const done = this.outcome(input, facts);
    if (!done) {
      throw this.fail("unknown", "executed");
    }
    return done;
  }

  /** A result counts once registered, or, in cloud mode, once durable in R2. */
  private outcome(input: TInput, facts: ResultFacts<TRecord>): TOutcome | null {
    if (!facts.record || !facts.artifactDurable) {
      return null;
    }
    if (facts.resultRegistered || this.uploadOnly) {
      return this.settled(input, facts.record, facts.resultRegistered);
    }
    return null;
  }

  private get uploadOnly() {
    return this.stepDeps.mode === "upload-only";
  }

  /** A failure never downgrades "executed"; otherwise the failure's own fact, when it has one, is kept. */
  private failureOf(attempt: StepAttempt<TInput>, failure: { error: unknown; aborted: boolean }) {
    const { code, fact } = this.classify(failure.error, failure.aborted);
    const kept = attempt.fact !== "executed" && fact ? fact : attempt.fact;
    return { error: failure.error, code, fact: kept };
  }

  /** After a failure, a result that was in fact completed still counts; absence is never assumed. */
  private async finishedMeanwhile(input: TInput): Promise<TOutcome | null> {
    try {
      const facts = await this.stepDeps.results.inspect(input, AbortSignal.timeout(RETENTION_MS));
      return this.outcome(input, facts);
    } catch {
      // Whether it finished cannot be shown now; the failure is recorded as a Review instead.
      return null;
    }
  }
}
