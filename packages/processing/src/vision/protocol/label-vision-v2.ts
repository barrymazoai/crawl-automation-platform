import { z } from "zod";
import {
  LabelImageCandidateSchema,
  LabelImageFieldSchema,
  assessLabelCandidate,
  labelImageIntegrityCodes,
  splitLabelIngredients,
} from "@crawl-automation/v3-contracts";
import { visionFailure } from "../vision-errors.js";
import { labelVisionPrompt, retainDailyValueHeading } from "./label-vision.js";
import { MAX_VISION_ANSWER_BYTES } from "./vision-limits.js";

// label-extraction/2 for images: the label plus the exact Other Ingredients body, split mechanically. The prompt and
// schema are part of its setup's fingerprint; a new rule is a new version, never an edit.
export const labelVisionWireV2Schema = z.strictObject({
  codec: z.literal("label-visual-wire/2"),
  label: LabelImageCandidateSchema,
  otherIngredientsBlock: LabelImageFieldSchema.nullable(),
});
export const labelVisionOutputV2Schema = z.toJSONSchema(labelVisionWireV2Schema);
export const labelVisionPromptV2 = `${labelVisionPrompt}
Instead of the bare label, return the label-visual-wire/2 envelope. Put the structured label in label.
FIRST transcribe the ENTIRE Other Ingredients BODY into otherIngredientsBlock.text and evidence identically, retaining all commas, semicolons, parentheses and words. Omit only its heading. Join visual line wraps with spaces, NEVER insert separators for a line wrap. Do not invent text from a known formulation. For an absent section use null and mark incomplete when appropriate. Illegible words must produce UNREADABLE, not a confident guess.
The structured Other Ingredients list will be derived mechanically from that exact body at top-level commas/semicolons. Do not drop adjectives or split a noun phrase merely because it spans lines.
For a blend component a printed percentage is a printed amount: put 90% in amount when that is actually printed, never not_declared. Each name.evidence must quote ONLY this component's own text and printed proportion, not its siblings. Do not convert percentages to mass. Carefully read every dose and DV digit; when uncertain use unreadable and an issue rather than plausible digits.`;

type Wire = z.infer<typeof labelVisionWireV2Schema>;
type Candidate = Wire["label"];

/** Other Ingredients items come from the transcribed body, split at top-level separators. */
function splitOtherIngredients(
  candidate: Candidate,
  block: Wire["otherIngredientsBlock"],
  codes: Set<string>,
) {
  if (!!candidate.otherIngredients !== !!block) {
    codes.add("LABEL.INGREDIENT_BOUNDARY");
  }
  if (!candidate.otherIngredients || !block) {
    return;
  }
  if (block.text !== block.evidence) {
    codes.add("LABEL.INGREDIENT_BOUNDARY");
    return;
  }
  try {
    const items = splitLabelIngredients(block.text).map((text) => ({ text, evidence: text }));
    candidate.otherIngredients.items = items;
  } catch {
    codes.add("LABEL.INGREDIENT_BOUNDARY");
  }
}

export function decodeLabelImageV2(response: string) {
  if (Buffer.byteLength(response) > MAX_VISION_ANSWER_BYTES) {
    throw visionFailure("VISION.OUTPUT_LIMIT", "executed");
  }
  const wire = labelVisionWireV2Schema.parse(JSON.parse(response));
  const candidate = retainDailyValueHeading(wire.label);
  const codes = new Set<string>();
  splitOtherIngredients(candidate, wire.otherIngredientsBlock, codes);
  const assessed = assessLabelCandidate(candidate);
  [...assessed.codes, ...labelImageIntegrityCodes(candidate)].forEach((code) => codes.add(code));
  const status = codes.size ? ("review" as const) : assessed.status;
  return { candidate, status, codes: [...codes] };
}
