import type { LabelCollectedProduct } from "@crawl-automation/v3-contracts";

type Formula = NonNullable<LabelCollectedProduct["formula"]>;

/** Printed text compared loosely: case, spacing, marks and the micro sign never make two labels different. */
function normalized(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[®™©*†‡]/gu, "")
    .replace(/\bµg\b|\bμg\b/gu, "mcg")
    .replace(/\s+/gu, " ")
    .trim();
}

function rowKeys(formula: Formula): string[] {
  return formula.columns
    .flatMap((column) => column.rows)
    .map((row) => `${normalized(row.name.text)}\u0000${normalized(row.amount?.text)}`)
    .sort();
}

/**
 * KAN-243 rule: two storefronts' labels are the same product when every row prints the same ingredient and the same
 * amount, and the serving size is the same. It never says two labels differ: a per-100 g Indian table or a copy
 * difference is not proof of another product, so anything else goes to the model.
 */
export function sameFormula(left: LabelCollectedProduct, right: LabelCollectedProduct): boolean {
  const [first, second] = [left.formula, right.formula];
  if (!first || !second) {
    return false;
  }
  const dosed = first.columns.some((column) => column.rows.some((row) => row.amount));
  const serving = normalized(first.servingSize?.text);
  if (!dosed || !serving || serving !== normalized(second.servingSize?.text)) {
    return false;
  }
  const [rows, others] = [rowKeys(first), rowKeys(second)];
  return rows.length === others.length && rows.every((key, index) => key === others[index]);
}
