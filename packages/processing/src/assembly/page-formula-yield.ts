import type { MarketLabelRules } from "../label/markets/market-rules.js";
import { assemblyErrors } from "./assembly-errors.js";
import type { LabelEvidence } from "./merge-state.js";
import type { splitLabel } from "./split-label.js";

type Split = NonNullable<ReturnType<typeof splitLabel>>;

/**
 * KAN-243 (owner 2026-11-07, India): a page whose formula differs from the label image's formula yields to the image,
 * with a warning; the image's formula is the one kept. Two images, or a page the split took the formula from, stay
 * conflicts.
 */
export function pageFormulaYields(
  entry: Pick<LabelEvidence, "id" | "kind">,
  codes: string[],
  at: {
    split: Split;
    market: MarketLabelRules;
    warnings: { id: string; code: string }[] | undefined;
  },
): string[] {
  const formulaConflict = assemblyErrors.code("LABEL_PRODUCT.FORMULA_CONFLICT");
  if (
    !at.market.pageFormulaYields ||
    entry.kind !== "text" ||
    at.split.complete.kind !== "image" ||
    !codes.includes(formulaConflict)
  ) {
    return codes;
  }
  const warning = assemblyErrors.code("LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT");
  if (at.warnings && !at.warnings.some((each) => each.id === entry.id && each.code === warning)) {
    at.warnings.push({ id: entry.id, code: warning });
  }
  return codes.filter((code) => code !== formulaConflict);
}
