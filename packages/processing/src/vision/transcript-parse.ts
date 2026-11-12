import {
  AppError,
  recordRecovery,
  type ErrorCategory,
  type ErrorCode,
} from "@crawl-automation/platform";
import type { LabelFormatId, LabelImageCandidate } from "@crawl-automation/v3-contracts";
import type { OcrReading } from "../keywords/ocr-text.js";
import { printedPercentHeader } from "../label/transcript/format-panel.js";
import { marketAmountPositions, marketRules } from "../label/markets/market-rules.js";
import type { LabelIngredientPresencePolicy } from "./protocol/label-ingredient-presence.js";
import { decodeTranscriptAnswer } from "./protocol/label-transcript-answer.js";
import { copiesPairedRows, transcriptCandidate } from "./protocol/label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./protocol/label-transcript-wire.js";

const INGREDIENTS_INCOMPLETE = "LABEL.INGREDIENTS_INCOMPLETE";
const AMOUNT_UNREADABLE = "LABEL.AMOUNT_UNREADABLE";

/**
 * The pure, CPU-only steps of reading a label copy: plain data in, plain data out, so a worker thread can run them.
 * KAN-243 (2026-11-12): one copy whose parse never ended held the label model worker's only thread, with its ten
 * model turns, heartbeats and polling; every step here is now run by a TranscriptParser.
 */
export const transcriptParseOps = {
  /** The copy read by the label rules, or why they cannot read it. */
  parsedCopy(
    raw: string,
    policy: Required<LabelIngredientPresencePolicy>,
    formats: readonly LabelFormatId[] | undefined,
  ) {
    try {
      const wire = labelTranscriptWireSchema.parse(JSON.parse(raw));
      if (copiesPairedRows(wire, formats)) {
        return { reason: "two ingredients in one row" };
      }
      return transcriptCandidate(wire, policy, formats);
    } catch (error) {
      recordRecovery(error, { operation: "vision/transcript-flow" });
      return { reason: "not a transcript" };
    }
  },

  /** KAN-243: the percentage column a copy in a non-US format names. */
  percentHeader(raw: string, formats: readonly LabelFormatId[]): string | null {
    try {
      return printedPercentHeader(labelTranscriptWireSchema.parse(JSON.parse(raw)).panels, formats);
    } catch (error) {
      recordRecovery(error, { operation: "vision/transcript-flow" });
      return null;
    }
  },

  amountPositions(
    candidate: LabelImageCandidate,
    ocr: OcrReading,
    formats: readonly LabelFormatId[] | undefined,
  ) {
    return marketAmountPositions(candidate, ocr, formats);
  },

  /** The answer's status and check codes. */
  decode(answer: string): { status: string; codes: string[] } {
    const { status, codes } = decodeTranscriptAnswer(answer);
    return { status, codes: [...codes] };
  },

  /**
   * Owner 2026-11-06 (Be Bodywise Biotin gummies): only the ingredients section is open, on an image the copy says does
   * not show that section.
   */
  ingredientsElsewhere(
    raw: string,
    codes: readonly string[],
    formats: readonly LabelFormatId[] | undefined,
  ): boolean {
    if (
      !codes.includes(INGREDIENTS_INCOMPLETE) ||
      codes.some((code) => code !== INGREDIENTS_INCOMPLETE && code !== AMOUNT_UNREADABLE)
    ) {
      return false;
    }
    const wire = marketRules(formats).copyWire(
      labelTranscriptWireSchema.parse(JSON.parse(raw)),
      formats ?? [],
    );
    return wire.otherIngredientsState === "not_fully_visible" && !wire.otherIngredients?.trim();
  },
};

export type TranscriptParseOps = typeof transcriptParseOps;
export type TranscriptParseOp = keyof TranscriptParseOps;
type Op<K extends TranscriptParseOp> = TranscriptParseOps[K];

/** Runs one parse step, here or in another thread with a time limit. */
export interface TranscriptParser {
  run<K extends TranscriptParseOp>(op: K, args: Parameters<Op<K>>): Promise<ReturnType<Op<K>>>;
}

/** Every step on the calling thread, exactly as before (tests, replays, and callers without a pool). */
export const inProcessTranscriptParser: TranscriptParser = {
  run: async (op, args) => runTranscriptParseOp(op, args),
};

export function runTranscriptParseOp<K extends TranscriptParseOp>(
  op: K,
  args: Parameters<Op<K>>,
): ReturnType<Op<K>> {
  const step = transcriptParseOps[op] as (...input: unknown[]) => ReturnType<Op<K>>;
  return step(...(args as unknown[]));
}

/** A step's outcome as plain data, so an AppError keeps its code across a thread. */
export type ParseOutcome = { value: unknown } | { error: SerializedError };
type SerializedError = {
  message: string;
  code?: string;
  category?: string;
  details?: Record<string, unknown>;
};

export function parseOutcome(work: () => unknown): ParseOutcome {
  try {
    return { value: work() };
  } catch (error) {
    if (error instanceof AppError) {
      const { message, code, category, details } = error;
      return { error: { message, code, category, details } };
    }
    return { error: { message: error instanceof Error ? error.message : String(error) } };
  }
}

/** The step's value, or its error rebuilt as it was thrown (an AppError with its code and details). */
export function parsedValue(outcome: ParseOutcome): unknown {
  if ("value" in outcome) {
    return outcome.value;
  }
  const { message, code, category, details } = outcome.error;
  if (code && category) {
    throw new AppError(code as ErrorCode, category as ErrorCategory, {
      message,
      ...(details ? { details } : {}),
    });
  }
  throw new Error(message);
}
