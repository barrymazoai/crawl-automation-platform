import { z } from "zod";
import {
  LABEL_FORMATS,
  LabelFormatIdSchema,
  isUsOnlyFormats,
  labelFormatsOf,
  type LabelFormatId,
} from "@crawl-automation/v3-contracts";
import { labelIngredientPresencePolicySchema } from "./label-ingredient-presence.js";

/**
 * Owner 2026-11-04 (docs/spark/2026-11-04-label-transcribe-then-parse-plan.md): the vision model only COPIES the facts
 * panel (each row's cells, indent, bold) and the Other Ingredients text; code parses the copy into the label answer
 * with the same rules as a web page's table. A new rule is a new version, never an edit: the prompt and schemas are
 * part of the setup's fingerprint.
 */
export const labelTranscriptProtocol = "label-visual-wire/4" as const;

const cell = z.string().max(4000);
const line = z.string().max(4000);
const TranscriptRowSchema = z.strictObject({
  cells: z.array(cell).min(1).max(12),
  indent: z.number().int().min(0).max(8),
  bold: z.boolean(),
});
const PanelSchema = z.strictObject({
  heading: line.nullable(),
  servingLines: z.array(line).max(10),
  columnHeaders: z.array(line).max(12),
  rows: z.array(TranscriptRowSchema).max(200),
  footnotes: z.array(line).max(40),
});
const IssueSchema = z.strictObject({
  code: z.enum(["UNREADABLE", "AMBIGUOUS", "FORMULA_MISSING", "INGREDIENTS_MISSING"]),
  detail: z.string().min(1).max(4000),
});

export const labelTranscriptWireSchema = z.strictObject({
  codec: z.literal(labelTranscriptProtocol),
  panels: z.array(PanelSchema).max(8),
  otherIngredientsHeading: line.nullable(),
  otherIngredients: z.string().max(20000).nullable(),
  otherIngredientsState: z.enum(["present", "none_printed", "not_fully_visible", "unreadable"]),
  wholeLabelVisible: z.boolean(),
  issues: z.array(IssueSchema).max(50),
});
export type LabelTranscriptWire = z.infer<typeof labelTranscriptWireSchema>;
export const labelTranscriptOutputSchema = z.toJSONSchema(labelTranscriptWireSchema);

/** The printed marker a copied cell carries when its characters cannot be read. */
export const UNREADABLE_CELL = "[UNREADABLE]";

export const labelTranscriptPrompt = `Transcribe the Supplement Facts / Nutrition Facts panel and the Other Ingredients text in the attached image. COPY, do not interpret. Return the ${labelTranscriptProtocol} envelope.
- One entry in "rows" per printed row of the table, top to bottom. If a row's name wraps onto several printed lines, join them into one cell with a single space.
- "cells": the row's cells left to right exactly as printed: the name, then each amount column, then each %DV column. Keep every character as printed (®, ™, *, †, ‡, parentheses, brackets, units, commas, "--"). Use "" for an empty cell. Do not merge columns; a table with several serving columns has one cell per column.
- A blend printed as "Blend Name: A, B (part), C" in one cell stays one cell exactly as printed. A list printed on its own line under a blend is its own row.
- "indent": 0 for a row at the left edge, 1 for one visible step of indentation, 2 for two, and so on.
- "bold": true when the row text is bold or a heading.
- "servingLines": the Serving Size / Servings Per Container lines as printed. "columnHeaders": the header row cells (e.g. "Amount Per Serving", "% Daily Value"). "footnotes": lines under the table.
- Read every digit and unit carefully. A character you cannot read is written ${UNREADABLE_CELL} in its cell, never a plausible guess, and reported as an UNREADABLE issue.
- "otherIngredientsHeading": the heading exactly as printed ("Other Ingredients:", "Ingredients:"), "otherIngredients": the ENTIRE body after it exactly as printed, joining visual line wraps with single spaces; both null when no such section is visible.
- "otherIngredientsState": present, none_printed, not_fully_visible, or unreadable. none_printed ONLY when the ENTIRE physical label is visible and readable and no separate ingredients section is printed (then wholeLabelVisible true). A Facts crop, one side of a bottle or an image of unknown coverage is not_fully_visible with wholeLabelVisible false. Null alone never establishes absence.
- Do not correct spelling, do not add anything not printed, do not decide what is a blend. If several facts panels are printed, one entry per panel.`;

/**
 * KAN-243: the copy prompt for an image selected in these label formats. US alone is the prompt above, byte for byte.
 * Another format adds its own lines; they belong to the format's versioned name, which every such task carries in its
 * keyword policy and answer, so they are not part of the setup fingerprint and are never edited in place.
 */
export function labelTranscriptPromptFor(formats: readonly LabelFormatId[] | undefined): string {
  if (isUsOnlyFormats(formats)) {
    return labelTranscriptPrompt;
  }
  const lines = labelFormatsOf(formats).flatMap((id) =>
    LABEL_FORMATS[id].prompt.map((line) => `- ${line}`),
  );
  return `${labelTranscriptPrompt}\n${lines.join("\n")}`;
}

/** Rows whose amounts the OCR text does not show are read once more, on their own. */
export const labelRereadWireSchema = z.strictObject({
  rows: z.array(z.strictObject({ name: line, amountCells: z.array(cell).max(8) })).max(200),
});
export const labelRereadOutputSchema = z.toJSONSchema(labelRereadWireSchema);
export function labelRereadPrompt(names: readonly string[]): string {
  return `Read these rows of the Supplement Facts / Nutrition Facts panel in the attached image, independently and carefully. For each row return its name as given and its amount cells exactly as printed, left to right (number and unit, e.g. "212 mcg", "1,000 mg"; never the %DV). Use ${UNREADABLE_CELL} for a character you cannot read. Do not guess from a known formulation.
Rows:
${names.map((name, at) => `${at + 1}. ${name}`).join("\n")}`;
}

/**
 * The retained answer: the model's exact copy, the caller's policy, and how each printed amount was confirmed (in the
 * OCR text, or by the independent re-read kept byte-exact here). Decoding needs nothing else.
 */
export const labelTranscriptAnswerSchema = z.strictObject({
  codec: z.literal("label-visual-answer/4"),
  policy: labelIngredientPresencePolicySchema.required(),
  raw: z.string(),
  /** Row indices (in the formula as parsed when the answer was made) whose amount the image's OCR prints there. */
  ocrConfirmed: z.array(z.number().int().nonnegative()).max(200),
  /**
   * Owner 2026-11-04: the image's OCR lines with their positions. A later decode parses the copy with that day's
   * rules and confirms each amount against these lines afresh; the row indices above are then not used (a changed
   * parse numbers the rows differently). Answers made before 2026-11-04 evening carry none and keep their indices.
   */
  ocrLines: z
    .array(
      z.strictObject({
        text: z.string().max(2000),
        polygon: z
          .array(z.tuple([z.number(), z.number()]))
          .max(8)
          .optional(),
      }),
    )
    .max(5000)
    .optional(),
  reread: z.string().nullable(),
  /** KAN-243: the label formats the copy was asked and is parsed in; absent for the US panel alone. */
  formats: z.array(LabelFormatIdSchema).min(1).max(20).optional(),
});
export type LabelTranscriptAnswer = z.infer<typeof labelTranscriptAnswerSchema>;
