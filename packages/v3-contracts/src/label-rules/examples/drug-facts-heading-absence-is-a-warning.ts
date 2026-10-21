import type { DrugFactsHeadingAbsenceSubject, LabelRuleExamples } from "../index.js";

const headingIssue = {
  code: "AMBIGUOUS",
  detail:
    "The label uses Active Ingredients and Inactive Ingredients without a Drug Facts heading.",
};
const retained = {
  formula: { drugFacts: null },
  formulaComplete: true,
  otherIngredients: { heading: "Ingredients" },
};

/** For warning rules, pass means the issue qualifies for the warning. */
export const drugFactsHeadingAbsenceExamples: LabelRuleExamples<DrugFactsHeadingAbsenceSubject> = {
  pass: [
    {
      subject: { ...retained, issues: [headingIssue] },
      source:
        "B0012DEKUK production rerun: Active/Inactive Ingredients without a Drug Facts heading",
    },
    {
      subject: {
        ...retained,
        issues: [
          {
            code: "METADATA_CONFLICT",
            detail: "No Drug Facts heading; Active and Inactive Ingredients are shown.",
          },
        ],
      },
      source: "constructed: same layout reported as metadata conflict",
    },
    {
      subject: {
        ...retained,
        issues: [
          {
            code: "AMBIGUOUS",
            detail:
              "This is not a standard Drug Facts layout; Active and Inactive Ingredients are listed.",
          },
        ],
      },
      source: "constructed: nonstandard Drug Facts layout wording",
    },
  ],
  fail: [
    {
      subject: {
        ...retained,
        issues: [
          {
            code: "METADATA_CONFLICT",
            detail:
              "The image contains two labels with different servings per container: 15 and 30; the schema provides one servingsPerContainer field.",
          },
        ],
      },
      source: "B0D61JFFQ8 vision-f586744b two label conflict",
    },
    {
      subject: {
        ...retained,
        issues: [
          { code: "AMBIGUOUS", detail: "Without a Drug Facts heading, amounts are not legible." },
        ],
      },
      source: "constructed: amounts not legible",
    },
    {
      subject: {
        ...retained,
        issues: [
          {
            code: "AMBIGUOUS",
            detail: "No Drug Facts heading, and two labels have different doses.",
          },
        ],
      },
      source: "constructed: heading and conflicting labels",
    },
    {
      subject: {
        ...retained,
        issues: [headingIssue, { code: "UNREADABLE", detail: "Amounts not legible." }],
      },
      source: "constructed: another uncertain issue remains",
    },
    {
      subject: { ...retained, formulaComplete: false, issues: [headingIssue] },
      source: "constructed: formula is incomplete",
    },
    {
      subject: { ...retained, otherIngredients: null, issues: [headingIssue] },
      source: "constructed: ingredients are absent",
    },
    {
      subject: { ...retained, formula: { drugFacts: "Drug Facts" }, issues: [headingIssue] },
      source: "constructed: cited heading contradicts the issue",
    },
  ],
};
