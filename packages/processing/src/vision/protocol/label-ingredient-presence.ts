import { z } from "zod";
import {
  LabelImageCandidateSchema,
  LabelImageFieldSchema,
  assessLabelCandidate,
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

/** Caller-authored envelope: the model cannot choose the acceptance policy. Raw stays byte-exact. */
const savedAnswerSchema = z.strictObject({
  codec: z.literal("label-visual-answer/3"),
  policy: labelIngredientPresencePolicySchema.required(),
  raw: z.string(),
});

export function retainIngredientPresenceAnswer(
  raw: string,
  policy: Partial<LabelIngredientPresencePolicy> = {},
): string {
  return JSON.stringify({
    codec: "label-visual-answer/3",
    policy: labelIngredientPresencePolicySchema.parse(policy),
    raw,
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
    ...retainDailyValueHeading(wire.label),
    ingredientDeclaration: {
      protocol: labelIngredientPresenceProtocol,
      state: wire.otherIngredientsState,
      wholeLabelVisible: wire.wholeLabelVisible,
      ...saved.policy,
    },
  });
  const codes = new Set<string>();
  splitOtherIngredients(candidate, wire.otherIngredientsBlock, codes);
  if (
    wire.otherIngredientsState !== "present" &&
    (candidate.otherIngredients || wire.otherIngredientsBlock)
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
