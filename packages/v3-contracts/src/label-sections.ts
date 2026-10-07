import { assessLabelCandidate, type LabelCandidate } from "./label-extraction.js";

export const partialLabelValidationCodes = [
  "LABEL.INGREDIENTS_INCOMPLETE",
  "LABEL.FORMULA_INCOMPLETE",
  "LABEL.AMOUNT_UNREADABLE",
  "LABEL.CORE_MISSING",
  "LABEL.EVIDENCE_UNCERTAIN",
] as const;

/** Select whole, explicitly complete printed sections; never join rows or extend ingredient lists. */
export function completeLabelSections<Candidate extends LabelCandidate>(
  candidate: Candidate,
): Candidate | null {
  if (candidate.formulaComplete && candidate.ingredientsComplete && candidate.issues.length) {
    return null;
  }
  const allowed = new Set<string>(partialLabelValidationCodes);
  // Judge only what is kept: a defect inside an incomplete section that is left out never discards the complete one.
  const kept = {
    ...candidate,
    formula: candidate.formulaComplete ? candidate.formula : null,
    otherIngredients: candidate.ingredientsComplete ? candidate.otherIngredients : null,
  };
  if (
    candidate.issues.some((issue) => ["AMBIGUOUS", "METADATA_CONFLICT"].includes(issue.code)) ||
    assessLabelCandidate(kept).codes.some((code) => !allowed.has(code))
  ) {
    return null;
  }
  const formula = candidate.formulaComplete ? candidate.formula : null;
  const otherIngredients = candidate.ingredientsComplete ? candidate.otherIngredients : null;
  if (!formula && !otherIngredients) {
    return null;
  }
  // Unreadability of an omitted section stays in original provenance, not in the selected section.
  const sections = {
    ...candidate,
    formula,
    otherIngredients,
    formulaComplete: !!formula,
    ingredientsComplete: candidate.ingredientsComplete,
    issues: [],
    exclusions: candidate.exclusions,
  };
  return assessLabelCandidate(sections).codes.some(
    (code) => code !== "LABEL.INGREDIENTS_INCOMPLETE",
  )
    ? null
    : sections;
}
