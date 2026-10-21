import type { LabelRule } from "./rule.js";
import type { LabelRow } from "./rows.js";

export interface DailyValueCell {
  columns: readonly { heading?: { text: string } | null; rows: readonly LabelRow[] }[];
  column: number;
  index: number;
}

const foodNutrient = /^(?:calories|total\s+fat|sodium|total\s+carb(?:ohydrate|ohydrates|\.)?)\b/iu;
const factsHeading = /\bnutrition\s+facts\b/iu;
const nonfoodHeading = /\b(?:supplement|drug)\s+facts\b/iu;

function foodPanel(column: DailyValueCell["columns"][number]): boolean {
  const heading = column.heading?.text ?? "";
  if (nonfoodHeading.test(heading)) return false;
  if (factsHeading.test(heading)) return true;
  const names = new Set(column.rows.filter((row) => foodNutrient.test(row.name.text)).map((row) => row.name.text.toLowerCase().replace(/\s+/gu, " ")));
  return names.size >= 3;
}

/** Accept a printed percent alone only inside an identifiable food nutrition column with other printed amounts. */
export const dailyValueOnlyRowRule: LabelRule<DailyValueCell> = {
  id: "daily-value-only-row",
  code: "LABEL.AMOUNT_MISSING",
  added: "2026-10-21",
  why: "B0DNKVNM7L Nutrition Facts prints Vit. D, Calcium, Iron and Potas. as 0% DV without separate amounts; B0C2TXLW5R shows why a percent-only column is not a dose column.",
  check({ columns, column, index }) {
    const own = columns[column];
    const row = own?.rows[index];
    if (!row || row.kind !== "nutrient" || row.amount !== null || row.amountStatus === "printed" || !row.dailyValue || !/\d\s*%/u.test(row.dailyValue.text)) return `column ${column} row ${index}: no nutrient with printed %DV and empty amount`;
    if (!own || !foodPanel(own)) return `column ${column} row ${index}: Nutrition Facts context not established`;
    if (!own.rows.some((other) => other !== row && other.amountStatus === "printed" && other.amount !== null)) return `column ${column} row ${index}: column prints no other amounts`;
    return null;
  },
};

export function acceptsDailyValueOnlyRow(subject: DailyValueCell): boolean {
  const row = subject.columns[subject.column]?.rows[subject.index];
  return !!row && row.amount === null && row.dailyValue !== null && dailyValueOnlyRowRule.check(subject) === null;
}
