import type { LabelRuleExamples, ServingUncertaintySubject } from "../index.js";

export const servingUncertaintyExamples: LabelRuleExamples<ServingUncertaintySubject> = {
  pass: [
    {
      subject: {
        formula: { servingSize: {}, servingsPerContainer: null },
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
        formula: { servingSize: {}, servingsPerContainer: null },
        issues: [
          {
            code: "UNREADABLE",
            detail: "Servings Per Container value is not printed or readable.",
          },
          { code: "INGREDIENTS_MISSING", detail: "No Other Ingredients section is visible." },
        ],
      },
      source: "B0G6G9VTQS vision-f0c3e499 also missing ingredients",
    },
    {
      subject: {
        formula: null,
        issues: [
          {
            code: "UNREADABLE",
            detail: "Servings per container is not visible in the supplied image.",
          },
        ],
      },
      source: "constructed: no formula even though serving count is unknown",
    },
    {
      subject: {
        formula: { servingSize: {}, servingsPerContainer: { text: "30" } },
        issues: [
          {
            code: "UNREADABLE",
            detail: "Servings per container is not visible in the supplied image.",
          },
        ],
      },
      source: "constructed: contradictory printed serving count",
    },
  ],
  fail: [
    {
      subject: {
        formula: { servingSize: {}, servingsPerContainer: null },
        issues: [
          {
            code: "UNREADABLE",
            detail: "Servings per container is not visible in the supplied image.",
          },
        ],
      },
      source: "B00J401J5W vision-f1098743 missing serving count",
    },
    {
      subject: {
        formula: { servingSize: {}, servingsPerContainer: null },
        issues: [
          {
            code: "METADATA_CONFLICT",
            detail: "Servings per container is not printed in the visible label area.",
          },
        ],
      },
      source: "B01MY5FJNR vision-f4a8511e missing serving count",
    },
    {
      subject: {
        formula: { servingSize: null, servingsPerContainer: {} },
        issues: [
          { code: "AMBIGUOUS", detail: "Serving size is not visible in the supplied image." },
        ],
      },
      source: "constructed: serving size alone is unknown",
    },
  ],
};
