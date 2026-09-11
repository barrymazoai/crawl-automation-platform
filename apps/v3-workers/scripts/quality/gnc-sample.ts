import { isDeepStrictEqual } from "node:util";
import { labelTypographyStructure, labelNameForComparison, type LabelCandidate } from "@crawl-automation/v3-contracts";
import fixture from "../../../../docs/quality/fixtures/gnc-613701-v1.json";

// Test/report utility only. Never authorizes collection, rewrites candidates or imports legacy rows.
export { fixture };
export function compareGncSample(candidate: LabelCandidate) {
  const shape = labelTypographyStructure(candidate, "label-typography/2");
  const formula = shape ? { servingSize: shape.servingSize, columns: shape.columns } : null;
  const ingredients = candidate.otherIngredients?.items.map(i => labelNameForComparison(i.text)) ?? null;
  const differences: string[] = [];
  const walk = (expected: unknown, actual: unknown, path: string) => {
    if (isDeepStrictEqual(expected, actual)) return;
    if (expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object") {
      if (Array.isArray(expected) !== Array.isArray(actual)) { differences.push(path); return; }
      const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
      if (Array.isArray(expected) && expected.length !== (actual as unknown[]).length) differences.push(`${path}.length`);
      for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) walk(e[key], a[key], `${path}.${key}`);
    } else differences.push(path);
  };
  walk(fixture.expected.formula, formula, "formula");
  walk(fixture.expected.otherIngredients, ingredients, "otherIngredients");
  return { fixtureId: fixture.id, status: differences.length ? "mismatch" as const : "match" as const, differences,
    formulaRows: shape?.columns.reduce((n, c) => n + c.rows.length, 0) ?? 0, otherIngredients: ingredients?.length ?? 0,
    printedServingsPerContainer: shape?.servingsPerContainer ?? null, userReviewed: false };
}
