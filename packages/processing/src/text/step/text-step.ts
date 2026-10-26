import {
  TextOutputSchema,
  textIdentity,
  type ReviewRecord,
  type TextActivityOutcome,
  type TextInput,
  type TextOutput,
  type TextRecord,
} from "@crawl-automation/v3-contracts";
import { CodexError } from "@crawl-automation/platform";
import type { ReviewReader, ReviewWriter } from "../../step/review-ledger.js";
import { ProcessingStep, type StepAttempt, type StepFailure } from "../../step/processing-step.js";
import type { ExecutionFact } from "../../step/step-failure.js";
import { executionFactOf, isKnownTextFailure, textFailure } from "../errors.js";
import type { SourceText } from "../evidence/text-evidence.js";
import { textLimits } from "../limits.js";
import type { TextModel } from "../ports.js";
import {
  decodeTextResult,
  textOutputSchema,
  textProtocolPrompt,
} from "../protocol/text-protocol.js";
import type { TextResults } from "../results/text-results.js";
import { admittedInput, assertSafeModel } from "./task-admission.js";
import { textReview } from "./text-review.js";

export interface TextStepDeps {
  model: TextModel;
  results: TextResults;
  reviews: ReviewWriter & ReviewReader;
  nodeId: string;
  /** "register" writes the ledger; "upload-only" (cloud mode) leaves registration to the receipt step. */
  mode?: "register" | "upload-only";
}

/**
 * Owner 2026-10-26: an answer the model cut off at its output limit returned nothing, so the step asks again, at most
 * twice (Iron Formula: 6 of 8 identical requests cut off, the other 2 answered in ~700 tokens). Every other model
 * failure still ends the call. No re-ask starts after 5 minutes, so the last one (timeoutMs 240 s) ends inside the
 * 12-minute activity.
 */
const TRUNCATED_REASKS = 2;
const REASK_WINDOW_MS = 5 * 60_000;

function isTruncatedAnswer(error: unknown): boolean {
  return (
    error instanceof CodexError &&
    error.code === "TEXT.CODEX_TURN_FAILED" &&
    (error.detail?.includes("reason: max_output_tokens") ?? false)
  );
}

const handoffCodes = {
  incomplete: "TEXT.HANDOFF_INCOMPLETE",
  unknown: "TEXT.HANDOFF_UNKNOWN",
  reviewUnknown: "TEXT.REVIEW_UNKNOWN",
} as const;

/**
 * The text step: calls the model on the task's source text (again only for a cut-off answer) and checks every quote
 * of its answer.
 */
export class TextStep extends ProcessingStep<
  TextInput,
  TextOutput,
  TextRecord,
  TextActivityOutcome,
  SourceText
> {
  constructor(private readonly deps: TextStepDeps) {
    super(deps);
    assertSafeModel(deps.model);
  }

  protected admit(raw: unknown): TextInput {
    return admittedInput(raw, this.deps.model);
  }

  protected readEvidence(input: TextInput, signal: AbortSignal): Promise<SourceText> {
    return this.deps.results.resolveSource(input, signal);
  }

  protected claim(input: TextInput, signal: AbortSignal): Promise<void> {
    return this.deps.results.claimIntent(input, this.deps.nodeId, signal);
  }

  /** The one model call: the raw answer is kept before it is checked, so a Review can show it. */
  protected async call(
    attempt: StepAttempt<TextInput>,
    source: SourceText,
    signal: AbortSignal,
  ): Promise<TextOutput> {
    const { input } = attempt;
    const prompt = textProtocolPrompt(input, source.text);
    const request = {
      operationId: input.operationId,
      prompt,
      outputSchema: textOutputSchema(input),
    };
    const response = await this.interpret(request, signal);
    attempt.fact = "executed";
    if (Buffer.byteLength(response) > textLimits.responseBytes) {
      throw textFailure("TEXT.OUTPUT_LIMIT", "executed");
    }
    attempt.candidate = { schema: "text-raw-response/1", value: { rawResponse: response } };
    await this.deps.results.retainResponse(input, response);
    const candidate = decodeTextResult(input, source.text, response);
    const output = TextOutputSchema.parse({
      ...textIdentity(input),
      provider: this.deps.model.provider,
      rawResponse: response,
      candidate,
    });
    attempt.candidate = { schema: "text-output/1", value: output };
    return output;
  }

  private async interpret(request: Parameters<TextModel["interpret"]>[0], signal: AbortSignal) {
    const started = Date.now();
    for (let reasked = 0; ; reasked++) {
      try {
        return await this.deps.model.interpret(request, signal);
      } catch (error) {
        const late = Date.now() - started >= REASK_WINDOW_MS;
        if (reasked >= TRUNCATED_REASKS || late || signal.aborted || !isTruncatedAnswer(error)) {
          throw error;
        }
      }
    }
  }

  protected settled(input: TextInput, record: TextRecord, registered: boolean) {
    const status = registered ? ("registered" as const) : ("uploaded" as const);
    return {
      status,
      operationId: input.operationId,
      result: record.result,
      completion: record.completion,
    };
  }

  /** The failure's own code (the text step's or the model client's); otherwise cancelled or unclassified. */
  protected classify(error: unknown, aborted: boolean) {
    const fallback = aborted ? "TEXT.CANCELLED" : "TEXT.UNCLASSIFIED";
    return {
      code: isKnownTextFailure(error) ? error.code : fallback,
      fact: executionFactOf(error),
    };
  }

  protected review(attempt: StepAttempt<TextInput>, failure: StepFailure): ReviewRecord {
    return textReview(attempt, failure);
  }

  protected reviewed(input: TextInput, review: ReviewRecord): TextActivityOutcome {
    return {
      status: "review",
      operationId: input.operationId,
      reviewId: review.reviewId,
      code: review.failure.code,
      automaticRetry: false,
    };
  }

  protected fail(reason: keyof typeof handoffCodes, fact?: ExecutionFact) {
    return textFailure(handoffCodes[reason], fact);
  }
}
