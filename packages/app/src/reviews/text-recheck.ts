import { textErrors } from "@crawl-automation/processing";
import { recordRecovery } from "@crawl-automation/platform";
import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import {
  decodeJson,
  decodeTextResult,
  parseTextTask,
  type TextSource,
} from "@crawl-automation/processing";
import {
  assertTextQuotes,
  type ReviewRecord,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** How a stored answer fares under today's decoding rules. */
export type RecheckStatus = "passes" | "fails" | "not_applicable" | "unavailable";

export interface RecheckResult {
  reviewId: string;
  operationId: string;
  /** The code the Review was recorded with. */
  recordedCode: string;
  status: RecheckStatus;
  /** Today's failure code, when it still fails or its evidence could not be read. */
  code: string | null;
  reason: string | null;
}

/** An intent file is small; this only bounds the read. */
const INTENT_BYTES = 2 * 1024 * 1024;
const StoredAnswerSchema = z.object({ rawResponse: z.string() });
const IntentSchema = z.object({ input: z.unknown() });
const ANSWER_SCHEMAS = new Set(["text-raw-response/1", "text-output/1"]);

type Outcome = Pick<RecheckResult, "status" | "code" | "reason">;

/** The model answer a text Review kept, or null when it kept none. */
function storedAnswer(review: ReviewRecord): string | null {
  const { candidate } = review;
  if (!candidate || !ANSWER_SCHEMAS.has(candidate.schema)) {
    return null;
  }
  const parsed = StoredAnswerSchema.safeParse(candidate.value);
  return parsed.success ? parsed.data.rawResponse : null;
}

/**
 * Re-decodes the model answer a text Review kept, with today's decoder and quote check, against the task's source
 * text read from R2. No model call and no writes: it only says whether the answer would pass now.
 */
export class TextAnswerRecheck {
  constructor(private readonly deps: { objects: Pick<ObjectStore, "read">; sources: TextSource }) {}

  async check(review: ReviewRecord, signal: AbortSignal): Promise<RecheckResult> {
    const { failure } = review;
    const identity = {
      reviewId: review.reviewId,
      operationId: failure.operationId,
      recordedCode: failure.code,
    };
    const answer = storedAnswer(review);
    if (failure.stage !== "codex.text" || answer === null) {
      const reason =
        failure.stage === "codex.text" ? "no stored model answer" : "not a text Review";
      return { ...identity, status: "not_applicable", code: null, reason };
    }
    const input = await this.task(review, signal);
    if (!input) {
      const reason = "the task's intent is missing from R2 or names another task";
      return { ...identity, status: "unavailable", code: null, reason };
    }
    return { ...identity, ...(await this.decode(input, answer, signal)) };
  }

  /** The task, from its intent file (a text Review's evidence key), when it is this Review's task. */
  private async task(review: ReviewRecord, signal: AbortSignal): Promise<TextInput | null> {
    const bytes = await this.deps.objects.read(review.failure.evidenceKey, INTENT_BYTES, signal);
    if (!bytes) {
      return null;
    }
    const input = parseTextTask(IntentSchema.parse(decodeJson(bytes)).input);
    const own =
      input.operationId === review.failure.operationId &&
      input.inputFingerprint === review.failure.inputFingerprint;
    return own ? input : null;
  }

  private async decode(input: TextInput, answer: string, signal: AbortSignal): Promise<Outcome> {
    let text: string;
    try {
      text = (await this.deps.sources.resolve(input, signal)).text;
    } catch (error) {
      recordRecovery(error, { operation: "text.recheck", operationId: input.operationId });
      return { status: "unavailable", code: errorCodeOf(error), reason: "source text unreadable" };
    }
    let candidate: ReturnType<typeof decodeTextResult>;
    try {
      candidate = decodeTextResult(input, text, answer);
    } catch (error) {
      recordRecovery(error, { operation: "text.recheck", operationId: input.operationId });
      return {
        status: "fails",
        code: errorCodeOf(error) ?? textErrors.code("TEXT.UNCLASSIFIED"),
        reason: null,
      };
    }
    try {
      assertTextQuotes(candidate, input, text);
    } catch (error) {
      recordRecovery(error, { operation: "text.recheck", operationId: input.operationId });
      // The quote check reports no code of its own; the text step records this as a citation failure.
      return { status: "fails", code: textErrors.code("TEXT.CITATION_INVALID"), reason: null };
    }
    return { status: "passes", code: null, reason: null };
  }
}
