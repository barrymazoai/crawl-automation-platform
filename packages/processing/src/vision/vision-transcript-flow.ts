import { recordRecovery } from "@crawl-automation/platform";
import { isUsOnlyFormats, type LabelFormatId } from "@crawl-automation/v3-contracts";
import type { OcrReading } from "../keywords/ocr-text.js";
import type {
  LabelIngredientPresencePolicy,
  TranscriptAttempt,
} from "./protocol/label-ingredient-presence.js";
import { dosedRows, transcriptAnswer } from "./protocol/label-transcript-answer.js";
import {
  labelRereadOutputSchema,
  labelRereadPrompt,
  labelTranscriptOutputSchema,
  labelTranscriptPromptFor,
} from "./protocol/label-transcript-wire.js";
import { inProcessTranscriptParser, type TranscriptParser } from "./transcript-parse.js";

/** The model calls one transcribed reading may make. */
export interface TranscriptCalls {
  /** The copy of the panel (label-visual-wire/4). */
  transcribe(): Promise<string>;
  /** An independent reading of the named rows' amounts. */
  reread(names: string[]): Promise<string>;
  /**
   * The label protocol the setup used before (label-visual-wire/3), already in its retained envelope, which keeps the
   * copy that was not accepted and why (owner 2026-11-05).
   */
  label(attempt: TranscriptAttempt, dailyValueHeading?: string | null): Promise<string>;
}

const AMOUNT_UNREADABLE = "LABEL.AMOUNT_UNREADABLE";

/** The copy and re-read one model asks, in the image's label formats (KAN-243), and its label-protocol fallback. */
export function transcriptCalls(
  run: (request: { prompt: string; outputSchema: object }) => Promise<string>,
  label: TranscriptCalls["label"],
  formats: readonly LabelFormatId[] | undefined,
): TranscriptCalls {
  return {
    transcribe: () =>
      run({ prompt: labelTranscriptPromptFor(formats), outputSchema: labelTranscriptOutputSchema }),
    reread: (names) =>
      run({ prompt: labelRereadPrompt(names), outputSchema: labelRereadOutputSchema }),
    label,
  };
}

/**
 * Owner 2026-11-04: copy, parse in code, confirm every printed amount (the image's OCR prints it on that row, else one
 * independent re-read of those rows repeats it). Anything else (a copy the rules cannot read, a check that fails, an
 * amount the OCR prints on another row, an amount the re-read does not repeat) is read with the label protocol exactly
 * as before, so a reading is never worse than today's.
 */
export async function transcribedAnswer(input: {
  calls: TranscriptCalls;
  ocr: OcrReading;
  policy: Required<LabelIngredientPresencePolicy>;
  /** KAN-243: the label formats the copy is parsed in; US alone when absent. */
  formats?: readonly LabelFormatId[] | undefined;
  /** KAN-243 2026-11-12: where the CPU-only parse steps run (a worker thread with a time limit in the worker). */
  parser?: TranscriptParser;
}): Promise<string> {
  const { calls, ocr, policy } = input;
  const parser = input.parser ?? inProcessTranscriptParser;
  const formats = input.formats && !isUsOnlyFormats(input.formats) ? [...input.formats] : undefined;
  const raw = await calls.transcribe();
  // KAN-243: a copy read in a non-US format names its percentage column; the label answer keeps that header.
  const heading = formats ? await parser.run("percentHeader", [raw, formats]) : null;
  const fallback = (reason: string, reread: string | null = null) =>
    calls.label({ raw, reason, reread }, heading);
  const built = await parser.run("parsedCopy", [raw, policy, formats]);
  if ("reason" in built) {
    return fallback(`copy not parsed: ${built.reason}`);
  }
  const positions = await parser.run("amountPositions", [built.candidate, ocr, formats]);
  if (positions.misplaced.length) {
    return fallback(`amount on another row: ${rowNames(built.candidate, positions.misplaced)}`);
  }
  const ocrConfirmed = positions.confirmed;
  const ocrLines = ocr.lines.map(({ text, polygon }) => (polygon ? { text, polygon } : { text }));
  const answerWith = (reread: string | null) =>
    transcriptAnswer({
      policy,
      raw,
      ocrConfirmed,
      ocrLines,
      reread,
      ...(formats ? { formats } : {}),
    });
  const unconfirmed = dosedRows(built.candidate)
    .filter(({ index }) => !ocrConfirmed.includes(index))
    .map(({ row }) => row.name.text);
  const elsewhere = (codes: readonly string[]) =>
    parser.run("ingredientsElsewhere", [raw, codes, formats]);
  return confirmedAnswer({ calls, parser, fallback, answerWith, unconfirmed, elsewhere });
}

/** The copy whose checks pass, or whose only open amounts one re-read repeats; otherwise the label protocol. */
async function confirmedAnswer(at: {
  calls: TranscriptCalls;
  parser: TranscriptParser;
  fallback: (reason: string, reread?: string | null) => Promise<string>;
  answerWith: (reread: string | null) => string;
  unconfirmed: string[];
  elsewhere: (codes: readonly string[]) => Promise<boolean>;
}): Promise<string> {
  const first = at.answerWith(null);
  const before = await at.parser.run("decode", [first]);
  if (before.status !== "review") {
    return first;
  }
  const elsewhere = await at.elsewhere(before.codes);
  if (!elsewhere && before.codes.some((code) => code !== AMOUNT_UNREADABLE)) {
    return at.fallback(`checks: ${before.codes.join(", ")}`);
  }
  if (!before.codes.includes(AMOUNT_UNREADABLE)) {
    return first;
  }
  const reread = await at.calls.reread(at.unconfirmed);
  const answer = at.answerWith(reread);
  const after = await decoded(at.parser, answer, elsewhere);
  return after.accepted ? answer : at.fallback(`re-read not accepted: ${after.reason}`, reread);
}

const INGREDIENTS_INCOMPLETE = "LABEL.INGREDIENTS_INCOMPLETE";

function rowNames(candidate: Parameters<typeof dosedRows>[0], indices: readonly number[]): string {
  const rows = candidate.formula?.columns[0]?.rows ?? [];
  return indices.map((index) => rows[index]?.name.text ?? `row ${index}`).join("; ");
}

/** Accepted: no open check, or (ingredients printed elsewhere) only the ingredients section open. */
async function decoded(
  parser: TranscriptParser,
  answer: string,
  elsewhere = false,
): Promise<{ accepted: boolean; reason: string }> {
  try {
    const result = await parser.run("decode", [answer]);
    const onlyIngredients =
      elsewhere && result.codes.every((code) => code === INGREDIENTS_INCOMPLETE);
    return {
      accepted: result.status !== "review" || onlyIngredients,
      reason: result.codes.join(", "),
    };
  } catch (error) {
    recordRecovery(error, { operation: "vision/transcript-flow" });
    return { accepted: false, reason: "answer not decoded" };
  }
}
