import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import {
  ReviewRecordSchema,
  TextReceiptInputSchema,
  TextRecordSchema,
  parseTextInput,
  textObservation,
  type ReviewRecord,
  type TextActivityOutcome,
  type TextInput,
  type TextReceiptOutcome,
} from "@crawl-automation/v3-contracts";
import type { TextFacts } from "../ports.js";
import { hashText } from "../results/text-record.js";
import { recordReceiptFailure, type ReviewLedger } from "./receipt-review.js";
import { receiptFailure } from "./receipt-errors.js";

export interface TextReceiptDeps {
  results: {
    inspect(input: TextInput, signal: AbortSignal): Promise<TextFacts>;
    registerFromRemote?(input: unknown, signal: AbortSignal): Promise<TextFacts>;
  };
  local: ObjectStore;
  reviews: ReviewLedger;
  /** Cloud mode: Reviews a ledger-less worker kept remotely; registered here only after identity checks. */
  remoteReviews?: { read(id: string): Promise<ReviewRecord | null> };
}

type Outcome = TextActivityOutcome | null | undefined;

/** Confirms a text task's result or Review; no model, upload or retry. Unknown execution means inspect only. */
export class TextReceipt {
  constructor(private readonly deps: TextReceiptDeps) {}

  async run(raw: unknown, signal: AbortSignal): Promise<TextReceiptOutcome> {
    const request = TextReceiptInputSchema.parse(raw);
    const input = parseTextInput(request.input, hashText);
    const outcome = request.outcome;
    try {
      signal.throwIfAborted();
      if (outcome && outcome.operationId !== input.operationId) {
        throw receiptFailure("TEXT_RECEIPT.IDENTITY_CONFLICT");
      }
      if (outcome?.status === "review") {
        return reviewReceipt(input, await this.confirmedReview(input, outcome));
      }
      return await this.confirmedResult(input, outcome, signal);
    } catch (error) {
      const record = await recordReceiptFailure({
        ...this.deps,
        input,
        outcome: outcome ?? null,
        error,
      });
      return reviewReceipt(input, record);
    }
  }

  /** An explicit Review is never promoted to success; a cloud Review enters the ledger only as this task's. */
  private async confirmedReview(input: TextInput, outcome: Extract<Outcome, { status: "review" }>) {
    const own = (raw: unknown) => ownReview(raw, input, outcome);
    const saved = await this.deps.reviews.read(outcome.reviewId);
    if (saved) {
      return own(saved);
    }
    const retained = await this.deps.remoteReviews?.read(outcome.reviewId);
    if (!retained) {
      throw receiptFailure("TEXT_RECEIPT.REVIEW_UNVERIFIED");
    }
    const record = own(retained);
    try {
      await this.deps.reviews.append(record);
    } catch {
      // Only the read-back below counts.
    }
    const confirmed = await this.deps.reviews.read(outcome.reviewId);
    if (!confirmed || !isDeepStrictEqual(ReviewRecordSchema.parse(confirmed), record)) {
      throw receiptFailure("TEXT_RECEIPT.REVIEW_UNVERIFIED");
    }
    return confirmed;
  }

  private async confirmedResult(
    input: TextInput,
    outcome: Outcome,
    signal: AbortSignal,
  ): Promise<TextReceiptOutcome> {
    if (outcome?.status === "uploaded") {
      // Cloud mode: durable but unregistered; rebuilt and verified from the remote bytes, then registered here.
      if (!this.deps.results.registerFromRemote) {
        throw receiptFailure("TEXT_RECEIPT.TEXT_UNCONFIRMED");
      }
      await this.deps.results.registerFromRemote(input, signal);
    }
    const facts = await this.deps.results.inspect(input, signal);
    if (!facts.resultRegistered || !facts.artifactDurable || !facts.record) {
      throw receiptFailure("TEXT_RECEIPT.TEXT_UNCONFIRMED");
    }
    const registration = TextRecordSchema.parse(facts.record);
    assertSameRegistration(registration, { input, outcome });
    return { status: "registered", registration };
  }
}

/** The ledger's registration is this task's, and matches the result the text step reported, if any. */
function assertSameRegistration(
  registration: ReturnType<typeof TextRecordSchema.parse>,
  reported: { input: TextInput; outcome: Outcome },
): void {
  const { outcome } = reported;
  const claimed =
    outcome?.status === "registered" || outcome?.status === "uploaded" ? outcome : null;
  const differs =
    claimed !== null &&
    (!isDeepStrictEqual(claimed.result, registration.result) ||
      !isDeepStrictEqual(claimed.completion, registration.completion));
  if (!isDeepStrictEqual(registration.input, reported.input) || differs) {
    throw receiptFailure("TEXT_RECEIPT.IDENTITY_CONFLICT");
  }
}

function ownReview(
  raw: unknown,
  input: TextInput,
  outcome: Extract<Outcome, { status: "review" }>,
) {
  const record = ReviewRecordSchema.parse(raw);
  const failure = record.failure;
  const matches =
    record.reviewId === outcome.reviewId &&
    failure.operationId === input.operationId &&
    failure.inputFingerprint === input.inputFingerprint &&
    failure.stage === "codex.text" &&
    failure.code === outcome.code &&
    isDeepStrictEqual(record.observation, textObservation(input));
  if (!matches) {
    throw receiptFailure("TEXT_RECEIPT.IDENTITY_CONFLICT");
  }
  return record;
}

function reviewReceipt(input: TextInput, record: ReviewRecord): TextReceiptOutcome {
  return {
    status: "review",
    operationId: input.operationId,
    reviewId: record.reviewId,
    code: record.failure.code,
    automaticRetry: false,
  };
}
