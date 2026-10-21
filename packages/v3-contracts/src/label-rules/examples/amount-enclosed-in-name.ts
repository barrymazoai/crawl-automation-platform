import type { LabelRuleExamples, RowSubject } from "../index.js";
import { column } from "./rows.js";

export const amountEnclosedInNameExamples: LabelRuleExamples<RowSubject> = {
  pass: [
    { subject: { rows: column([["nutrient", null, "Includes 4g Added Sugars"]]), index: 0 }, source: "B0GV197H9K vision-f4470ef4 Includes 4g Added Sugars" },
    { subject: { rows: column([["nutrient", null, "Includes 3.5 g Added Sugars"]]), index: 0 }, source: "8572440903818 text-f21c19e0 Includes 3.5 g Added Sugars" },
  ],
  fail: [
    { subject: { rows: column([["nutrient", null, "Includes Added Sugars"]]), index: 0 }, source: "8572162605194 text-f34355cc Includes Added Sugars with no number" },
  ],
};
