import type { LabelRule } from "./rule.js";

export interface DrugFactsHeadingAbsenceSubject {
  formula: { drugFacts?: unknown | null } | null;
  formulaComplete: boolean;
  otherIngredients: unknown | null;
  issues: readonly { code: string; detail: string }[];
}

const uncertaintyCodes = new Set(["UNREADABLE", "AMBIGUOUS", "METADATA_CONFLICT"]);
const headingAbsence =
  /without\s+a\s+drug\s+facts\s+heading|no\s+drug\s+facts\s+heading|not\s+a\s+(?:standard\s+)?drug\s+facts/i;
const otherUncertainty =
  /\b(?:doses?|dosages?|amounts?|different|differing|two\s+labels?|multiple\s+labels?|servings?|strength|conflict(?:ing)?|unreadable|illegible|unclear|uncertain)\b/i;

/** An absent Drug Facts title alone does not invalidate a complete retained formula and ingredient list. */
export const drugFactsHeadingAbsenceIsAWarningRule: LabelRule<DrugFactsHeadingAbsenceSubject> = {
  id: "drug-facts-heading-absence-is-a-warning",
  code: "LABEL.DRUG_FACTS_HEADING_ABSENT",
  added: "2026-10-21",
  why: "B0012DEKUK has a complete formula and Ingredients list; its sole ambiguity reports the absent Drug Facts heading, not uncertain contents.",
  check({ formula, formulaComplete, otherIngredients, issues }) {
    const uncertain = issues.filter((issue) => uncertaintyCodes.has(issue.code));
    const issue = uncertain.length === 1 ? uncertain[0] : null;
    if (!formula || formula.drugFacts != null || !formulaComplete || !otherIngredients || !issue)
      return null;
    if (issue.code !== "AMBIGUOUS" && issue.code !== "METADATA_CONFLICT") return null;
    if (!headingAbsence.test(issue.detail) || otherUncertainty.test(issue.detail)) return null;
    return `model reported ${issue.code}: ${issue.detail.slice(0, 160)}`;
  },
};
