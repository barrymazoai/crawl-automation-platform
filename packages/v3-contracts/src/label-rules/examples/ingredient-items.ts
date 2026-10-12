import type { LabelRuleExamples } from "../index.js";

export const ingredientItemExamples: LabelRuleExamples<string> = {
  pass: [
    { subject: "gelatin (capsule)", source: "label-extraction.test split case (2026-09-28)" },
    { subject: "coating (water, starch [corn, rice])", source: "label-extraction.test split case (2026-09-28)" },
  ],
  fail: [{ subject: "(capsule)", source: "label-extraction.test: \"(capsule), water\" split off its ingredient" }],
};
