import { z } from "zod";
import {
  LabelImageCandidateSchema,
  LabelImageFieldSchema,
  assessLabelCandidate,
  hasClosedPrintedIngredients,
  isIngredientHeading,
  labelImageIntegrityCodes,
  legacyLabelExtractionSchema,
} from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../../label/validation-errors.js";
import { visionFailure } from "../vision-errors.js";
import { splitOtherIngredients } from "./ingredient-transcription.js";
import { retainDailyValueHeading } from "./label-vision.js";
import { labelVisionPromptV2 } from "./label-vision-v2.js";
import { MAX_VISION_ANSWER_BYTES } from "./vision-limits.js";

export const labelIngredientPresenceProtocol = "label-visual-wire/3" as const;
export const labelIngredientPresencePolicySchema = z.strictObject({
  allowNoOtherIngredientsSection: z.boolean().default(true),
});
export type LabelIngredientPresencePolicy = z.infer<typeof labelIngredientPresencePolicySchema>;

export const labelIngredientPresenceWireSchema = z.strictObject({
  codec: z.literal(labelIngredientPresenceProtocol),
  label: LabelImageCandidateSchema.omit({ ingredientDeclaration: true }),
  otherIngredientsBlock: LabelImageFieldSchema.nullable(),
  otherIngredientsState: z.enum(["present", "none_printed", "not_fully_visible", "unreadable"]),
  wholeLabelVisible: z.boolean(),
});
export const labelIngredientPresenceOutputSchema = z.toJSONSchema(
  labelIngredientPresenceWireSchema.extend({
    label: legacyLabelExtractionSchema(LabelImageFieldSchema),
  }),
);
export const labelIngredientPresencePrompt = `${labelVisionPromptV2}
Use the NEW label-visual-wire/3 envelope instead of label-visual-wire/2. Keep label.codec label-extraction/1.
Report otherIngredientsState explicitly: present, none_printed, not_fully_visible, or unreadable. Null alone NEVER establishes absence.
none_printed is allowed ONLY when the ENTIRE physical label is visible and readable, including every area where a separate Ingredients/Other Ingredients section could appear. A complete Supplement Facts crop, one side of a bottle, a hidden wraparound panel, or an image of unknown coverage is NOT the whole label: use not_fully_visible and wholeLabelVisible false. Any illegible possible ingredients text means unreadable. Never infer absence from marketing, product knowledge, or the Facts panel alone.
When the whole label is visible and no separate ingredients section is printed, set none_printed, wholeLabelVisible true, otherIngredients null, otherIngredientsBlock null, and ingredientsComplete true only if all printed ingredient information in Facts is completely extracted. Do not report INGREDIENTS_MISSING merely for this confirmed absence. Do not invent an empty heading, ingredient, or evidence quote. Retain carrier oils printed inside Facts in their original row/amount; never duplicate or move them to Other Ingredients.
When the section is present, transcribe it as before. When cut off, hidden, unreadable or uncertain, ingredientsComplete MUST be false and report the actual issue. formulaComplete and all dose checks remain independent.
A blend_component with NO individual printed amount is not_declared when its parent blend_total has a readable printed total. That is complete evidence, not UNREADABLE or FORMULA_MISSING. Never use this exception for a group_header without a printed total, or replace an actually unreadable dose with not_declared.`;

/**
 * Owner 2026-11-05: when the copy-then-parse reading (label-visual-wire/4) is not accepted, the copy, why it was not
 * accepted and its re-read are kept with the label answer read instead, so the cause can be looked up later. Never
 * read when the answer is decoded.
 */
const TranscriptAttemptSchema = z.strictObject({
  raw: z.string(),
  reason: z.string().max(2000),
  reread: z.string().nullable(),
});
export type TranscriptAttempt = z.infer<typeof TranscriptAttemptSchema>;

/** Caller-authored envelope: the model cannot choose the acceptance policy. Raw stays byte-exact. */
const savedAnswerSchema = z.strictObject({
  codec: z.literal("label-visual-answer/3"),
  policy: labelIngredientPresencePolicySchema.required(),
  raw: z.string(),
  transcriptAttempt: TranscriptAttemptSchema.optional(),
  /**
   * KAN-243: the percentage column's header as the copy printed it ("%RDA"), named by the caller when the copy was
   * read in a non-US label format; the model's own label answer has no place for it.
   */
  dailyValueHeading: z.string().min(1).max(200).optional(),
});

export function retainIngredientPresenceAnswer(
  raw: string,
  policy: Partial<LabelIngredientPresencePolicy> = {},
  kept: {
    transcriptAttempt?: TranscriptAttempt | undefined;
    dailyValueHeading?: string | null | undefined;
  } = {},
): string {
  const { transcriptAttempt, dailyValueHeading } = kept;
  return JSON.stringify({
    codec: "label-visual-answer/3",
    policy: labelIngredientPresencePolicySchema.parse(policy),
    raw,
    ...(transcriptAttempt
      ? { transcriptAttempt: TranscriptAttemptSchema.parse(transcriptAttempt) }
      : {}),
    ...(dailyValueHeading ? { dailyValueHeading } : {}),
  });
}

export function isIngredientPresenceAnswer(raw: string): boolean {
  if (Buffer.byteLength(raw) > MAX_VISION_ANSWER_BYTES) {
    throw visionFailure("VISION.OUTPUT_LIMIT", "executed");
  }
  return JSON.parse(raw)?.codec === "label-visual-answer/3";
}

/** Pure decoding also used by reviews.recheck; no model calls and no current-config dependency. */
export function decodeIngredientPresenceAnswer(response: string) {
  if (Buffer.byteLength(response) > MAX_VISION_ANSWER_BYTES) {
    throw visionFailure("VISION.OUTPUT_LIMIT", "executed");
  }
  const saved = savedAnswerSchema.parse(JSON.parse(response));
  const wire = labelIngredientPresenceWireSchema.parse(JSON.parse(saved.raw));
  const candidate = LabelImageCandidateSchema.parse({
    ...withPrintedHeading(retainDailyValueHeading(wire.label), saved.dailyValueHeading),
    ingredientDeclaration: {
      protocol: labelIngredientPresenceProtocol,
      state: wire.otherIngredientsState,
      wholeLabelVisible: wire.wholeLabelVisible,
      ...saved.policy,
    },
  });
  return judgeIngredientPresence(candidate, wire.otherIngredientsBlock);
}

/**
 * The copy's percentage header on the one column whose rows print percentages (never on several columns, never over
 * a header the answer already has).
 */
function withPrintedHeading<Label extends ReturnType<typeof retainDailyValueHeading>>(
  label: Label,
  heading: string | undefined,
): Label {
  const columns = label.formula?.columns ?? [];
  const [column] = columns;
  if (!heading || columns.length !== 1 || !column || column.dailyValueHeading) {
    return label;
  }
  if (!column.rows.some((row) => row.dailyValue)) {
    return label;
  }
  const dailyValueHeading = { text: heading, evidence: heading };
  return {
    ...label,
    formula: { ...label.formula, columns: [{ ...column, dailyValueHeading }] },
  } as Label;
}

/**
 * The checks every answer reporting ingredient presence meets (label-visual-wire/3 and the transcript protocol): the
 * list is split from its exact body, a closed list needs no whole-label view, and a list beside a reported absence is
 * a boundary conflict.
 */
export function judgeIngredientPresence(
  candidate: z.infer<typeof LabelImageCandidateSchema>,
  block: z.infer<typeof LabelImageFieldSchema> | null,
) {
  const state = candidate.ingredientDeclaration?.state;
  const codes = new Set<string>();
  splitOtherIngredients(candidate, block, codes);
  const closedList = !codes.size && hasClosedIngredientList(candidate);
  if (closedList) {
    candidate.ingredientsComplete = true;
    candidate.issues = candidate.issues.filter((issue) => !isWholeLabelCoverageIssue(issue));
  }
  if (
    state !== "present" &&
    (candidate.otherIngredients || block) &&
    !(state === "not_fully_visible" && closedList)
  ) {
    codes.add(labelValidationErrors.code("LABEL.INGREDIENT_BOUNDARY"));
  }
  const assessed = assessLabelCandidate(candidate);
  [...assessed.codes, ...labelImageIntegrityCodes(candidate)].forEach((code) => codes.add(code));
  return {
    candidate,
    status: codes.size ? ("review" as const) : assessed.status,
    codes: [...codes],
  };
}

/** Whole-package coverage is unnecessary when the printed ingredient section itself closes. */
function hasClosedIngredientList(candidate: z.infer<typeof LabelImageCandidateSchema>): boolean {
  const declaration = candidate.ingredientDeclaration;
  const other = candidate.otherIngredients;
  if (
    !other ||
    !isIngredientHeading(other.heading.text) ||
    !["present", "not_fully_visible"].includes(declaration?.state ?? "")
  ) {
    return false;
  }
  return (
    hasClosedPrintedIngredients(candidate) &&
    candidate.issues.every(
      (issue) =>
        !["INGREDIENTS_MISSING", "AMBIGUOUS"].includes(issue.code) ||
        isWholeLabelCoverageIssue(issue),
    )
  );
}

function isWholeLabelCoverageIssue(issue: { code: string; detail: string }): boolean {
  if (!["INGREDIENTS_MISSING", "AMBIGUOUS"].includes(issue.code)) {
    return false;
  }
  return (
    /(?:whole|entire|full)\s+(?:physical\s+)?label|label\s+coverage/iu.test(issue.detail) &&
    !/label\s+ingredient\s+list|(?:section|body|text)s?\s+(?:(?:is|are)\s+)?not\s+visible|cropp|cut\s+off|obscur|unreadab|illegib|partially\s+visible|may\s+continue|continu\w*\s+beyond/iu.test(
      issue.detail,
    )
  );
}
