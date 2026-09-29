import {
  TextOutputSchema,
  textIdentity,
  type TextActivityOutcome,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import type { PrivateReviewReader, ReviewWriter } from "@crawl-automation/v3-review";
import { textFailure, type ExecutionFact } from "../errors.js";
import type { TextFacts, TextModel } from "../ports.js";
import {
  decodeTextResult,
  textOutputSchema,
  textProtocolPrompt,
} from "../protocol/text-protocol.js";
import type { TextResults } from "../results/text-results.js";
import { admittedInput, assertSafeModel, finishedOutcome } from "./task-admission.js";
import { recordTextReview, textReview } from "./text-review.js";
import { textLimits } from "../limits.js";

export interface TextStepDeps {
  model: TextModel;
  results: TextResults;
  reviews: ReviewWriter & PrivateReviewReader;
  nodeId: string;
  /** "register" writes the ledger; "upload-only" (cloud mode) leaves registration to the receipt step. */
  mode?: "register" | "upload-only";
}

interface Attempt {
  input: TextInput;
  fact: ExecutionFact;
  response: string | null;
  output: ReturnType<typeof TextOutputSchema.parse> | null;
}

/**
 * The text step: reads the task's source text, calls the model once, checks every quote, stores and registers the
 * result. Any failure becomes a Review that records whether the model ran; nothing is retried.
 */
export class TextStep {
  constructor(private readonly deps: TextStepDeps) {
    assertSafeModel(deps.model);
  }

  async run(raw: unknown, signal: AbortSignal): Promise<TextActivityOutcome> {
    const attempt: Attempt = {
      input: admittedInput(raw, this.deps.model),
      fact: "not_executed",
      response: null,
      output: null,
    };
    try {
      return await this.execute(attempt, signal);
    } catch (error) {
      const found = await this.finishedMeanwhile(attempt.input);
      if (found) {
        return found;
      }
      const review = textReview({ ...attempt, error, aborted: signal.aborted });
      await recordTextReview(this.deps.reviews, review);
      return {
        status: "review",
        operationId: attempt.input.operationId,
        reviewId: review.reviewId,
        code: review.failure.code,
        automaticRetry: false,
      };
    }
  }

  private async execute(attempt: Attempt, signal: AbortSignal): Promise<TextActivityOutcome> {
    const { input } = attempt;
    const { results } = this.deps;
    signal.throwIfAborted();
    const previous = await results.inspect(input, signal);
    const completed = this.outcome(input, previous);
    if (completed) {
      return completed;
    }
    if (previous.record) {
      throw textFailure("TEXT.HANDOFF_INCOMPLETE", "executed");
    }
    const source = await results.resolveSource(input, signal);
    attempt.fact = "unknown";
    await results.claimIntent(input, this.deps.nodeId, signal);
    signal.throwIfAborted();
    await this.callModel(attempt, source.text, signal);
    return this.storeAndRegister(attempt, signal);
  }

  /** The one model call: the raw answer is kept before it is checked, so a Review can show it. */
  private async callModel(
    attempt: Attempt,
    sourceText: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { input } = attempt;
    const prompt = textProtocolPrompt(input, sourceText);
    const request = {
      operationId: input.operationId,
      prompt,
      outputSchema: textOutputSchema(input),
    };
    const response = await this.deps.model.interpret(request, signal);
    attempt.fact = "executed";
    if (Buffer.byteLength(response) > textLimits.responseBytes) {
      throw textFailure("TEXT.OUTPUT_LIMIT", "executed");
    }
    attempt.response = response;
    await this.deps.results.retainResponse(input, response);
    const candidate = decodeTextResult(input, sourceText, response);
    const provider = this.deps.model.provider;
    const identity = textIdentity(input);
    attempt.output = TextOutputSchema.parse({
      ...identity,
      provider,
      rawResponse: response,
      candidate,
    });
  }

  /** Stores the checked output, uploads it, and registers it (in cloud mode the receipt registers it). */
  private async storeAndRegister(
    attempt: Attempt,
    signal: AbortSignal,
  ): Promise<TextActivityOutcome> {
    const { input, output } = attempt;
    const { results } = this.deps;
    if (!output) {
      throw textFailure("TEXT.HANDOFF_INCOMPLETE", "executed");
    }
    await results.capture(input, output, AbortSignal.timeout(textLimits.retentionMs));
    signal.throwIfAborted();
    await results.uploadMissing(input, signal);
    const facts = this.uploadOnly
      ? await results.inspect(input, signal)
      : await results.register(input, signal);
    const registered = this.outcome(input, facts);
    if (!registered) {
      throw textFailure("TEXT.HANDOFF_UNKNOWN", "executed");
    }
    return registered;
  }

  private get uploadOnly() {
    return this.deps.mode === "upload-only";
  }

  private outcome(input: TextInput, facts: TextFacts): TextActivityOutcome | null {
    return finishedOutcome(input, facts, this.uploadOnly);
  }

  /** After a failure, a result that was in fact completed still counts; absence is never assumed. */
  private async finishedMeanwhile(input: TextInput): Promise<TextActivityOutcome | null> {
    try {
      return this.outcome(
        input,
        await this.deps.results.inspect(input, AbortSignal.timeout(textLimits.retentionMs)),
      );
    } catch {
      // Whether it finished cannot be shown now; the failure is recorded as a Review instead.
      return null;
    }
  }
}
