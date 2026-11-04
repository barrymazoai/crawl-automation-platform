import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../../label/validation-errors.js";
import { visionFailure } from "../vision-errors.js";
import { squashAmount } from "./label-amount-position.js";
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

/** The copied panel parsed in code, read with the same checks as every label answer; needs no model and no OCR. */
export function decodeTranscriptAnswer(response: string) {
  const saved = labelTranscriptAnswerSchema.parse(JSON.parse(response));
  const built = transcriptCandidate(
    labelTranscriptWireSchema.parse(JSON.parse(saved.raw)),
    saved.policy,
  );
  if ("reason" in built) {
    throw visionFailure("VISION.INVALID_OUTPUT", "executed");
  }
  const judged = judgeIngredientPresence(built.candidate, built.block);
  const codes = new Set(judged.codes);
  const confirmed = new Set([
    ...saved.ocrConfirmed,
    ...rereadConfirmedRows(built.candidate, saved.reread),
  ]);
  if (dosedRows(built.candidate).some(({ index }) => !confirmed.has(index))) {
    codes.add(labelValidationErrors.code("LABEL.AMOUNT_UNREADABLE"));
  }
  return {
    candidate: judged.candidate,
    status: codes.size ? ("review" as const) : judged.status,
    codes: [...codes],
  };
}

export function transcriptAnswer(parts: Omit<LabelTranscriptAnswer, "codec">): string {
  return JSON.stringify({ codec: "label-visual-answer/4", ...parts });
}
