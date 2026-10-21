import type { CellSubject, LabelRuleExamples } from "../index.js";
import { column, type CompactRow } from "./rows.js";

/** sambucolusa.com Day & Night capsules, vision-522a6ff0-9460-4f2f-bb5f-05b646c41155 (2026-10-21). */
const night: CompactRow[] = [
  ["nutrient", null, "California Poppy Extract (Eschscholzia californica) (Flower)", "500 mg"],
  ["nutrient", null, "Black Elderberry Juice Extract (Sambucus nigra L.) (Fruit)", "162 mg"],
  ["nutrient", null, "English Ivy Extract (Hedera helix) (Leaf)", "140 mg"],
  ["nutrient", null, "White Willow Extract (Salix alba) (Bark/Stem)", "80 mg"],
];
const day: CompactRow[] = [
  ["nutrient", null, "California Poppy Extract (Eschscholzia californica) (Flower)"],
  ["nutrient", null, "Black Elderberry Juice Extract (Sambucus nigra L.) (Fruit)", "162 mg"],
  ["nutrient", null, "English Ivy Extract (Hedera helix) (Leaf)", "140 mg"],
  ["nutrient", null, "White Willow Extract (Salix alba) (Bark/Stem)", "80 mg"],
];

/** The stored answer marks the blank Day cell not_applicable; the rule reads not_declared the same way. */
const sambucol = (status: "not_applicable" | "not_declared"): CellSubject["columns"] => {
  const dayRows = column(day);
  dayRows[0] = { ...dayRows[0]!, amountStatus: status };
  return [{ rows: dayRows }, { rows: column(night) }];
};

/** The same table with the Night cell blank too: no column prints the dose. */
const blankEverywhere: CellSubject["columns"] = [
  { rows: column(day) },
  { rows: column([["nutrient", null, "California Poppy Extract (Eschscholzia californica) (Flower)"], ...night.slice(1)]) },
];

/** B0C2TXLW5R vision-fa921d77-7777 (2026-10-21): the "%DV*" heading returned as a second column holding only a blank Calories cell. */
const dailyValueColumn: CellSubject["columns"] = [
  { rows: column([["nutrient", null, "Calories", "4"], ["nutrient", null, "Total Carbohydrates", "5 g"]]) },
  { rows: column([["nutrient", null, "Calories"]]) },
];

export const emptyCellExamples: LabelRuleExamples<CellSubject> = {
  pass: [
    { subject: { columns: sambucol("not_applicable"), column: 0, index: 0 }, source: "vision-522a6ff0 Day column, California Poppy blank" },
    { subject: { columns: sambucol("not_declared"), column: 0, index: 0 }, source: "vision-522a6ff0 Day column, status not_declared" },
    { subject: { columns: sambucol("not_applicable"), column: 1, index: 0 }, source: "vision-522a6ff0 Night column, California Poppy 500 mg" },
    { subject: { columns: sambucol("not_applicable"), column: 0, index: 1 }, source: "vision-522a6ff0 Day column, Black Elderberry 162 mg" },
  ],
  fail: [
    { subject: { columns: blankEverywhere, column: 0, index: 0 }, source: "constructed: California Poppy blank in both columns" },
    { subject: { columns: dailyValueColumn, column: 1, index: 0 }, source: "vision-fa921d77 %DV column, Calories blank" },
  ],
};
