import type { LabelRule } from "./rule.js";
import { rowName, type RowSubject } from "./rows.js";

const PERCENT = /\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*%/g;
const percentKey = (text: string) => text.replace(/\s/g, "").replace("–", "-");

/** A percentage outside parentheses/brackets that opens or closes the component's text is its share of the blend. */
function blendProportion(evidence: string): boolean {
  let depth = 0;
  let outside = "";
  for (const c of evidence) {
    if (c === "(" || c === "[") depth++;
    outside += depth ? " " : c;
    if ((c === ")" || c === "]") && depth) depth--;
  }
  const text = outside.trim().replace(/^[\s,;:.]+|[\s,;:.]+$/g, "");
  return new RegExp(`^${PERCENT.source}`).test(text) || new RegExp(`${PERCENT.source}$`).test(text);
}

export const blendPercentageRule: LabelRule<RowSubject> = {
  id: "blend-percentage-is-share",
  code: "LABEL.AMOUNT_EVIDENCE_CONFLICT",
  added: "2026-10-12",
  why:
    "A blend component's percentage is its dose only as its share of the blend (\"90% Whey\", \"EPA 18%\"); " +
    "\"(95% curcuminoids)\" or \"standardized to 1% Nitrate\" describes the extract. The first version demanded " +
    "every quoted percentage as the amount and rejected 166 real standardization rows.",
  check({ rows, index }) {
    const row = rows[index]!;
    if (row.kind !== "blend_component") return null;
    // Image answers quote the printed text as `evidence`; text answers cite a span, whose `text` is that quote.
    const evidence = "evidence" in row.name ? row.name.evidence : row.name.text;
    const percentages = evidence.match(PERCENT) ?? [];
    if (!percentages.length) return null;
    const printed = row.amount && row.amountStatus === "printed" ? row.amount.text : null;
    const quoted = new Set(percentages.map(percentKey));
    const conflict = printed
      ? (printed.match(PERCENT) ?? []).some((p) => !quoted.has(percentKey(p)))
      : blendProportion(evidence);
    if (!conflict) return null;
    const amount = row.amount ? `"${row.amount.text.slice(0, 30)}"` : row.amountStatus;
    return `row ${index} ${rowName(row)}: name quotes ${percentages.join(", ")} but amount is ${amount}`;
  },
};
