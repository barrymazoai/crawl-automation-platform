const NAME = /[A-Za-z]{3,}/;
/** A printed value: "2%", "180%", "20 mg", "<1 g", "1,000 mcg DFE". */
const VALUE = /^[<>≤]?\s*\d[\d,.]*\s*(?:%|[a-zA-Zµμ].*)?$/;

/**
 * Owner 2026-11-06 (a Nutrition Facts copy among the stored answers since 11-04: "Iron | 2% | Thiamine (B1) | 180%"
 * under the headers "Amount Per Serving | % Daily Value"): a row that prints a second ingredient and its value after
 * the first one's value holds two ingredients. The row rules read one name per row and would drop the second, so such
 * a copy is not read by them. Two whole tables side by side under repeated headers are split by sideBySide instead.
 */
export function printsPairedRow(cells: readonly string[]): boolean {
  return cells.some((cell, at) => {
    const next = cells[at + 1]?.trim() ?? "";
    return at >= 2 && NAME.test(cell) && !VALUE.test(cell.trim()) && VALUE.test(next);
  });
}
