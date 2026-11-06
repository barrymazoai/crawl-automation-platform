import { recordRecovery } from "@crawl-automation/platform";
import { isUsOnlyFormats, type LabelFormatId } from "@crawl-automation/v3-contracts";
import type { OcrReading } from "../keywords/ocr-text.js";
import { amountPositions } from "./protocol/label-amount-position.js";
import type {
  LabelIngredientPresencePolicy,
  TranscriptAttempt,
} from "./protocol/label-ingredient-presence.js";
import {
  decodeTranscriptAnswer,
  dosedRows,
  transcriptAnswer,
} from "./protocol/label-transcript-answer.js";
import { printedPercentHeader } from "../label/transcript/format-panel.js";
import { transcriptCandidate } from "./protocol/label-transcript-candidate.js";
import {
  labelRereadOutputSchema,
  labelRereadPrompt,
  labelTranscriptOutputSchema,
  labelTranscriptPromptFor,
  labelTranscriptWireSchema,
} from "./protocol/label-transcript-wire.js";

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
}): Promise<string> {
  const { calls, ocr, policy } = input;
  const formats = input.formats && !isUsOnlyFormats(input.formats) ? [...input.formats] : undefined;
  const raw = await calls.transcribe();
  // KAN-243: a copy read in a non-US format names its percentage column; the label answer keeps that header.
  const heading = formats ? copiedPercentHeader(raw, formats) : null;
  const fallback = (reason: string, reread: string | null = null) =>
    calls.label({ raw, reason, reread }, heading);
  const built = parsed(raw, policy, formats);
  if ("reason" in built) {
    return fallback(`copy not parsed: ${built.reason}`);
  }
  const positions = amountPositions(built.candidate, ocr);
  if (positions.misplaced.length) {
    return fallback(`amount on another row: ${rowNames(built.candidate, positions.misplaced)}`);
  }
  const ocrConfirmed = positions.confirmed;
  const ocrLines = ocr.lines.map(({ text, polygon }) => (polygon ? { text, polygon } : { text }));
  const kept = formats ? { formats } : {};
  const first = transcriptAnswer({ policy, raw, ocrConfirmed, ocrLines, reread: null, ...kept });
  const before = decodeTranscriptAnswer(first);
  if (before.status !== "review") {
    return first;
  }
  if (before.codes.some((code) => code !== AMOUNT_UNREADABLE)) {
    return fallback(`checks: ${before.codes.join(", ")}`);
  }
  const names = dosedRows(built.candidate)
    .filter(({ index }) => !ocrConfirmed.includes(index))
    .map(({ row }) => row.name.text);
  const reread = await calls.reread(names);
  const answer = transcriptAnswer({ policy, raw, ocrConfirmed, ocrLines, reread, ...kept });
  const after = decoded(answer);
  return after.accepted ? answer : fallback(`re-read not accepted: ${after.reason}`, reread);
}

function parsed(
  raw: string,
  policy: Required<LabelIngredientPresencePolicy>,
  formats: readonly LabelFormatId[] | undefined,
) {
  try {
    return transcriptCandidate(labelTranscriptWireSchema.parse(JSON.parse(raw)), policy, formats);
  } catch (error) {
    recordRecovery(error, { operation: "vision/transcript-flow" });
    return { reason: "not a transcript" };
  }
}

function copiedPercentHeader(raw: string, formats: readonly LabelFormatId[]): string | null {
  try {
    return printedPercentHeader(labelTranscriptWireSchema.parse(JSON.parse(raw)).panels, formats);
  } catch (error) {
    recordRecovery(error, { operation: "vision/transcript-flow" });
    return null;
  }
}

function rowNames(candidate: Parameters<typeof dosedRows>[0], indices: readonly number[]): string {
  const rows = candidate.formula?.columns[0]?.rows ?? [];
  return indices.map((index) => rows[index]?.name.text ?? `row ${index}`).join("; ");
}

function decoded(answer: string): { accepted: boolean; reason: string } {
  try {
    const result = decodeTranscriptAnswer(answer);
    return { accepted: result.status !== "review", reason: result.codes.join(", ") };
  } catch (error) {
    recordRecovery(error, { operation: "vision/transcript-flow" });
    return { accepted: false, reason: "answer not decoded" };
  }
}
