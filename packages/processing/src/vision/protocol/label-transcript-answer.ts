import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { splitFinalAnd } from "../../label/transcript/final-and.js";
import { labelValidationErrors } from "../../label/validation-errors.js";
import { visionFailure } from "../vision-errors.js";
import { squashAmount } from "./label-amount-position.js";
import { judgeIngredientPresence } from "./label-ingredient-presence.js";
import { transcriptCandidate } from "./label-transcript-candidate.js";
import { marketAmountPositions } from "../../label/markets/market-rules.js";
import {
  labelRereadWireSchema,
  labelTranscriptAnswerSchema,
  labelTranscriptWireSchema,
  type LabelTranscriptAnswer,
  type LabelTranscriptWire,
} from "./label-transcript-wire.js";
import { MAX_VISION_ANSWER_BYTES } from "./vision-limits.js";

type Row = NonNullable<LabelImageCandidate["formula"]>["columns"][number]["rows"][number];

/** The formula rows that print an amount, with their index in the column. */
export function dosedRows(candidate: LabelImageCandidate): { index: number; row: Row }[] {
  const rows = candidate.formula?.columns[0]?.rows ?? [];
  return rows.flatMap((row, index) => (row.amount ? [{ index, row }] : []));
}

/**
 * Rows the independent re-read printed with the same amount: its first cell is the amount, or (owner 2026-11-08,
 * KAN-243: an Indian table prints "per 100 g" before "per serving", and its unit in the row name, "cholesterol (mg)
 * <1.0 0.0") its cells, left to right, are the copied row's amount cells and the selected amount is one of them.
 */
export function rereadConfirmedRows(
  candidate: LabelImageCandidate,
  reread: string | null,
  copied?: LabelTranscriptWire,
): number[] {
  if (!reread) {
    return [];
  }
  const answer = labelRereadWireSchema.parse(JSON.parse(reread));
  const copiedRows = copied?.panels.flatMap((panel) => panel.rows) ?? [];
  return dosedRows(candidate)
    .filter(({ row }) =>
      answer.rows.some(
        (read) =>
          read.name === row.name.text &&
          (squashAmount(read.amountCells[0] ?? "") === squashAmount(row.amount?.text ?? "") ||
            readsCopiedCells(read.amountCells, row, copiedRows)),
      ),
    )
    .map(({ index }) => index);
}

const PERCENT_ONLY = /%|^[\s*†‡•°○–—-]*$/u;

/** The re-read's cells are the copied row's amount cells in order (a %DV column after them aside). */
function readsCopiedCells(
  cells: readonly string[],
  row: Row,
  copiedRows: readonly LabelTranscriptWire["panels"][number]["rows"][number][],
): boolean {
  const selected = row.amount?.text ?? "";
  return copiedRows.some((copy) => {
    if ((copy.cells[0] ?? "").trim() !== row.name.text.trim()) {
      return false;
    }
    const amounts = copy.cells.slice(1).filter((cell) => cell.trim() && !PERCENT_ONLY.test(cell));
    const at = amounts.findIndex((cell) => sameCell(cell, selected));
    return (
      cells.length > 0 &&
      at >= 0 &&
      at < cells.length &&
      cells.every((cell, index) => amounts[index] !== undefined && sameCell(amounts[index], cell))
    );
  });
}

/** The same printed amount; a bare number (its unit printed in the row name) matches that number with a unit. */
function sameCell(copied: string, read: string): boolean {
  const one = squashAmount(copied);
  const other = squashAmount(read);
  if (one === other) {
    return true;
  }
  const bare = /^[<>≤≥]?\d+(?:\.\d+)?$/u;
  return bare.test(one) && other.startsWith(one) && /^[a-z]+$/u.test(other.slice(one.length));
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
  const copied = labelTranscriptWireSchema.parse(JSON.parse(saved.raw));
  const built = transcriptCandidate(copied, saved.policy, saved.formats);
  if ("reason" in built) {
    throw visionFailure("VISION.INVALID_OUTPUT", "executed");
  }
  const judged = judgeIngredientPresence(built.candidate, built.block);
  withFinalAnd(judged.candidate);
  const codes = new Set(judged.codes);
  const byOcr = ocrConfirmedRows(built.candidate, saved);
  const confirmed = new Set([
    ...(byOcr ?? []),
    ...rereadConfirmedRows(built.candidate, saved.reread, copied),
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

/** The copied list's last "A and B" is two items, as on a web page's copy (owner 2026-11-06). */
function withFinalAnd(candidate: LabelImageCandidate): void {
  const other = candidate.otherIngredients;
  const texts = other?.items.map((item) => item.text) ?? [];
  const split = splitFinalAnd(texts);
  if (!other || split.length === texts.length) {
    return;
  }
  const pair = split.slice(-2).map((text) => ({ text, evidence: text }));
  other.items = [...other.items.slice(0, -1), ...pair];
}

/** Rows the OCR confirms, placed by this parse; null when the OCR prints a copied amount on another row. */
function ocrConfirmedRows(candidate: LabelImageCandidate, saved: LabelTranscriptAnswer) {
  if (!saved.ocrLines) {
    return saved.ocrConfirmed;
  }
  const lines = saved.ocrLines.map(({ text, polygon }) => (polygon ? { text, polygon } : { text }));
  const positions = marketAmountPositions(candidate, { text: "", lines }, saved.formats);
  return positions.misplaced.length ? null : positions.confirmed;
}

export function transcriptAnswer(parts: Omit<LabelTranscriptAnswer, "codec">): string {
  return JSON.stringify({ codec: "label-visual-answer/4", ...parts });
}
