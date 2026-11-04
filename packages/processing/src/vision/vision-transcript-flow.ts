import { recordRecovery } from "@crawl-automation/platform";
import type { LabelIngredientPresencePolicy } from "./protocol/label-ingredient-presence.js";
import {
  decodeTranscriptAnswer,
  dosedRows,
  ocrConfirmedRows,
  transcriptAnswer,
} from "./protocol/label-transcript-answer.js";
import { transcriptCandidate } from "./protocol/label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./protocol/label-transcript-wire.js";

/** The model calls one transcribed reading may make. */
export interface TranscriptCalls {
  /** The copy of the panel (label-visual-wire/4). */
  transcribe(): Promise<string>;
  /** An independent reading of the named rows' amounts. */
  reread(names: string[]): Promise<string>;
  /** The label protocol the setup used before (label-visual-wire/3), already in its retained envelope. */
  label(): Promise<string>;
}

const AMOUNT_UNREADABLE = "LABEL.AMOUNT_UNREADABLE";

/**
 * Owner 2026-11-04: copy, parse in code, confirm every printed amount (in the image's OCR text, else by one independent
 * re-read of those rows). Anything else (a copy the rules cannot read, a check that fails, an amount the re-read does
 * not repeat) is read with the label protocol exactly as before, so a reading is never worse than today's.
 */
export async function transcribedAnswer(input: {
  calls: TranscriptCalls;
  ocrText: string;
  policy: Required<LabelIngredientPresencePolicy>;
}): Promise<string> {
  const { calls, ocrText, policy } = input;
  const raw = await calls.transcribe();
  const built = parsed(raw, policy);
  if (!built) {
    return calls.label();
  }
  const ocrConfirmed = ocrConfirmedRows(built.candidate, ocrText);
  const first = transcriptAnswer({ policy, raw, ocrConfirmed, reread: null });
  const before = decodeTranscriptAnswer(first);
  if (before.status !== "review") {
    return first;
  }
  if (before.codes.some((code) => code !== AMOUNT_UNREADABLE)) {
    return calls.label();
  }
  const names = dosedRows(built.candidate)
    .filter(({ index }) => !ocrConfirmed.includes(index))
    .map(({ row }) => row.name.text);
  const reread = await calls.reread(names);
  const answer = transcriptAnswer({ policy, raw, ocrConfirmed, reread });
  return accepted(answer) ? answer : calls.label();
}

function parsed(raw: string, policy: Required<LabelIngredientPresencePolicy>) {
  try {
    const built = transcriptCandidate(labelTranscriptWireSchema.parse(JSON.parse(raw)), policy);
    return "reason" in built ? null : built;
  } catch (error) {
    recordRecovery(error, { operation: "vision/transcript-flow" });
    return null;
  }
}

function accepted(answer: string): boolean {
  try {
    return decodeTranscriptAnswer(answer).status !== "review";
  } catch (error) {
    recordRecovery(error, { operation: "vision/transcript-flow" });
    return false;
  }
}
