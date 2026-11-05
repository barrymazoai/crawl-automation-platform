import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../../label/validation-errors.js";
import { visionFailure } from "../vision-errors.js";
import { amountPositions, squashAmount } from "./label-amount-position.js";
import { judgeIngredientPresence } from "./label-ingredient-presence.js";
import { transcriptCandidate } from "./label-transcript-candidate.js";
import {
  labelRereadWireSchema,
  labelTranscriptAnswerSchema,
  labelTranscriptWireSchema,
  type LabelTranscriptAnswer,
} from "./label-transcript-wire.js";
import { MAX_VISION_ANSWER_BYTES } from "./vision-limits.js";

type Row = NonNullable<LabelImageCandidate["formula"]>["columns"][number]["rows"][number];

/** The formula rows that print an amount, with their index in the column. */
export function dosedRows(candidate: LabelImageCandidate): { index: number; row: Row }[] {
  const rows = candidate.formula?.columns[0]?.rows ?? [];
  return rows.flatMap((row, index) => (row.amount ? [{ index, row }] : []));
}

/** Rows the independent re-read printed with the same amount. */
export function rereadConfirmedRows(
  candidate: LabelImageCandidate,
  reread: string | null,
): number[] {
  if (!reread) {
    return [];
  }
  const answer = labelRereadWireSchema.parse(JSON.parse(reread));
  return dosedRows(candidate)
    .filter(({ row }) =>
      answer.rows.some(
        (read) =>
          read.name === row.name.text &&
          squashAmount(read.amountCells[0] ?? "") === squashAmount(row.amount?.text ?? ""),
      ),
    )
    .map(({ index }) => index);
}

export function isTranscriptAnswer(raw: string): boolean {
  if (Buffer.byteLength(raw) > MAX_VISION_ANSWER_BYTES) {
    throw visionFailure("VISION.OUTPUT_LIMIT", "executed");
  }
  return JSON.parse(raw)?.codec === "label-visual-answer/4";
}

/**
 * The copied panel parsed in code, read with the same checks as every label answer; needs no model and no OCR call.
 * Each printed amount is confirmed by the retained OCR lines (placed on its row by today's parse) or by the retained
 * re-read (by row name); an amount the OCR prints on another row is never confirmed.
 */
export function decodeTranscriptAnswer(response: string) {
  const saved = labelTranscriptAnswerSchema.parse(JSON.parse(response));
  const built = transcriptCandidate(
    labelTranscriptWireSchema.parse(JSON.parse(saved.raw)),
    saved.policy,
    saved.formats,
  );
  if ("reason" in built) {
    throw visionFailure("VISION.INVALID_OUTPUT", "executed");
  }
  const judged = judgeIngredientPresence(built.candidate, built.block);
  const codes = new Set(judged.codes);
  const byOcr = ocrConfirmedRows(built.candidate, saved);
  const confirmed = new Set([
    ...(byOcr ?? []),
    ...rereadConfirmedRows(built.candidate, saved.reread),
  ]);
  if (dosedRows(built.candidate).some(({ index }) => !confirmed.has(index)) || !byOcr) {
    codes.add(labelValidationErrors.code("LABEL.AMOUNT_UNREADABLE"));
  }
  return {
    candidate: judged.candidate,
    status: codes.size ? ("review" as const) : judged.status,
    codes: [...codes],
  };
}

/** Rows the OCR confirms, placed by this parse; null when the OCR prints a copied amount on another row. */
function ocrConfirmedRows(candidate: LabelImageCandidate, saved: LabelTranscriptAnswer) {
  if (!saved.ocrLines) {
    return saved.ocrConfirmed;
  }
  const lines = saved.ocrLines.map(({ text, polygon }) => (polygon ? { text, polygon } : { text }));
  const positions = amountPositions(candidate, { text: "", lines });
  return positions.misplaced.length ? null : positions.confirmed;
}

export function transcriptAnswer(parts: Omit<LabelTranscriptAnswer, "codec">): string {
  return JSON.stringify({ codec: "label-visual-answer/4", ...parts });
}
