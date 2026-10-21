import type { DailyValueCell, LabelRuleExamples } from "../index.js";
import { column } from "./rows.js";

const avocado = column([
  ["nutrient", null, "Calories", "140"],
  ["nutrient", null, "Total Fat", "15g"],
  ["nutrient", null, "Sodium", "210mg"],
  ["nutrient", null, "Vit. D"],
]);
avocado[3] = { ...avocado[3]!, dailyValue: { text: "0%", evidence: "0%" }, amountStatus: "not_declared" };

/** B0C2TXLW5R vision-fa921d77: model returned a separate %DV column with a blank Calories cell. */
const percentColumn = [{ rows: column([["nutrient", null, "Calories", "4"], ["nutrient", null, "Total Carbohydrates", "5 g"]]) }, { heading: { text: "%DV*" }, rows: column([["nutrient", null, "Calories"]]) }];

export const dailyValueOnlyRowExamples: LabelRuleExamples<DailyValueCell> = {
  pass: [{ subject: { columns: [{ heading: { text: "Amount per serving" }, rows: avocado }], column: 0, index: 3 }, source: "B08HZB2HM7 vision-feb21541 Vit. D 0% with Calories, Total Fat and Sodium amounts" }],
  fail: [{ subject: { columns: percentColumn, column: 1, index: 0 }, source: "B0C2TXLW5R vision-fa921d77 %DV-only column has no amount" }],
};
