import type { LabelRule } from "./rule.js";

export interface ServingUncertaintySubject {
  formula: { servingSize: unknown | null; servingsPerContainer: unknown | null } | null;
  issues: readonly { code: string; detail: string }[];
}

const uncertaintyCodes = new Set(["UNREADABLE", "AMBIGUOUS", "METADATA_CONFLICT"]);
const missingServingMetadata =
  /^(?:the\s+)?(?:servings?\s+per\s+container|serving\s+size)(?:\s+(?:value|field))?\s+(?:is|was|are)\s+(?:not\s+(?:printed|visible|readable|legible|shown|provided|stated)|missing|unreadable)(?:\s+or\s+(?:not\s+)?(?:printed|visible|readable|legible|shown|provided|stated))?(?:\s+(?:in|on)\s+[^.;:,]+)?\.?$/iu;
const otherSubject =
  /\b(?:and|but|while|whereas|different|conflict|two|multiple|ingredient|formula|dose|amount)\b/iu;
const servingSize = /^(?:the\s+)?serving\s+size\b/iu;

/** A single uncertain serving count/size does not make an otherwise retained formula uncertain. */
export const servingsPerContainerUncertaintyIsAWarningRule: LabelRule<ServingUncertaintySubject> = {
  id: "servings-per-container-uncertainty-is-a-warning",
  code: "LABEL.SERVINGS_PER_CONTAINER_UNCERTAIN",
  added: "2026-10-21",
  why: "B00J401J5W and B01MY5FJNR have readable formulas but no visible servings per container; B0D61JFFQ8 has two conflicting labels and must remain Review.",
  check({ formula, issues }) {
    const issue = issues.length === 1 ? issues[0] : null;
    if (!formula || !issue || !uncertaintyCodes.has(issue.code)) return null;
    if (!missingServingMetadata.test(issue.detail) || otherSubject.test(issue.detail)) return null;
    if (
      servingSize.test(issue.detail)
        ? formula.servingSize !== null
        : formula.servingsPerContainer !== null
    )
      return null;
    return `model reported ${issue.code}: ${issue.detail.slice(0, 160)}`;
  },
};
