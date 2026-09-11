import { labelFormulaStructure, type LabelCandidate } from "./label-extraction.js";
/** Comparison only. Never rewrite source fields, citations, amounts or group coordinates. */
export const labelTypographyVersion = "label-typography/1" as const;
export const labelNameForComparison = (s: string) => s.replace(/[™®]/gu, "").normalize("NFC").replace(/[‘’]/gu, "'").replace(/\s+/gu, " ").trim();
const amount = (s: string | null) => s?.replace(/^(\d+(?:\.\d+)?)\s*(mcg|mg|g|kg|mL|ml|L|IU)$/, "$1 $2") ?? null;
const dailyValue = (s: string | null) => s?.replace(/^(\d+(?:\.\d+)?\s*%)\s*[*+†‡]+$/, "$1") ?? null;
export function labelTypographyStructure(candidate: LabelCandidate, policy: "label-typography/1" | "label-typography/2" = "label-typography/1") {
  const shape = labelFormulaStructure(candidate);
  // HTML may serialize the adjacent % DV header into the amount column heading.
  // Only this exact per-serving heading is equivalent; per-container/100 g axes stay distinct.
  const heading = (s: string | null) => s && (policy === "label-typography/2"
    ? /^amounts? per serving(?:\s+%\s*(?:DV|Daily Value))?$/i
    : /^amounts? per serving$/i).test(s) ? "Amount Per Serving" : s;
  return shape ? { ...shape, columns: shape.columns.map(c => ({ ...c,
    heading: heading(c.heading),
    rows: c.rows.map(r => ({ ...r, name: labelNameForComparison(r.name!), amount: amount(r.amount), dailyValue: dailyValue(r.dailyValue) })),
  })) } : null;
}
