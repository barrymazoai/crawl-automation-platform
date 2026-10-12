import { assessLabelCandidate, type LabelImageCandidate, type LabelCandidate, type LabelFinding } from "./label-extraction.js";
import { blendPercentageRule } from "./label-rules/blend-percentage.js";
import { ingredientNotOnlyParenthesisRule } from "./label-rules/ingredient-items.js";
import { applyLabelRules } from "./label-rules/rule.js";

/** Opt-in quality/1: evidence consistency, not an assertion that pixels were read correctly. */
export function labelImageIntegrityCodes(candidate: LabelImageCandidate) {
  return [...new Set(labelImageIntegrityFindings(candidate).map(f => f.code))];
}
/** Same checks as labelImageIntegrityCodes, naming the component or item that failed each one. */
export function labelImageIntegrityFindings(candidate: LabelImageCandidate): LabelFinding[] {
  const findings: LabelFinding[] = [];
  for (const column of candidate.formula?.columns ?? []) column.rows.forEach((_, index) =>
    findings.push(...applyLabelRules([blendPercentageRule], { rows: column.rows, index })));
  const bad = candidate.otherIngredients?.items.find(i => ingredientNotOnlyParenthesisRule.check(i.text) !== null);
  if (bad) findings.push(...applyLabelRules([ingredientNotOnlyParenthesisRule], bad.text));
  return findings;
}

/** Split the original IMAGE transcription only, retaining parenthesized subingredients. */
export function splitLabelIngredients(block: string): string[] {
  const parts: string[] = [], stack: string[] = []; let start = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (c === "(" || c === "[") stack.push(c);
    if (c === ")" || c === "]") { if (stack.pop() !== (c === ")" ? "(" : "[")) throw Error("LABEL.INGREDIENT_BOUNDARY"); }
    if ((c === "," || c === ";") && stack.length === 0) { parts.push(block.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(block.slice(start).trim());
  if (stack.length || parts.some(p => !p || /^\([^()]+\)[.]?$/.test(p)) || /^\s*other\s+ingredients/i.test(block)) throw Error("LABEL.INGREDIENT_BOUNDARY");
  return parts;
}

type Evidence = {kind: string; candidate: LabelCandidate};
const name = (s: string) => s.normalize("NFC").replace(/[™®]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const number = (s: string | undefined) => {
  if (!s) return null;
  const m = s.trim().match(/^(\d+(?:,\d{3})*(?:\.\d+)?)\s*(mcg|mg|g|kg|ml|l|iu|%)[*†‡]*$/i);
  return m ? `${Number(m[1]!.replace(/,/g, ""))}:${m[2]!.toLowerCase()}` : null;
};
/** Compare only unambiguous same-axis, same-name rows; no taxonomy, unit conversion or guessing. */
export function labelNumericSourceConflict(entries: Evidence[]) {
  const complete = entries.filter(p => p.candidate.formulaComplete && p.candidate.ingredientsComplete && assessLabelCandidate(p.candidate).status === "candidate");
  for (const a of complete.filter(p => p.kind === "image")) for (const b of complete.filter(p => p.kind === "text")) {
    const x = a.candidate.formula!, y = b.candidate.formula!;
    if (x.columns.length !== 1 || y.columns.length !== 1 || name(x.servingSize?.text ?? "") !== name(y.servingSize?.text ?? "")) continue;
    const axis = (s: string) => /^amounts? per serving(?:\s+%\s*(?:dv|daily value))?$/i.test(s.trim());
    if (!axis(x.columns[0]!.heading?.text ?? "") || !axis(y.columns[0]!.heading?.text ?? "")) continue;
    const key = (r: typeof x.columns[number]["rows"][number]) => `${r.kind}:${name(r.name.text)}`;
    for (const r of x.columns[0]!.rows) {
      // Components depend on grouping; do not infer row correspondence across changed groups.
      if (r.kind !== "nutrient" && r.kind !== "blend_total") continue;
      const matches = y.columns[0]!.rows.filter(s => key(s) === key(r));
      if (matches.length !== 1 || x.columns[0]!.rows.filter(s => key(s) === key(r)).length !== 1) continue;
      for (const field of ["amount", "dailyValue"] as const) {
        const left = number(r[field]?.text), right = number(matches[0]![field]?.text);
        if (left && right && left !== right) return true;
      }
    }
  }
  return false;
}
