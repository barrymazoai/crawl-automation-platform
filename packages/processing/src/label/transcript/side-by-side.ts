/** What the split reads of a copied panel: its column headers and rows of cells. */
interface Panel<Row extends { cells: string[] }> {
  columnHeaders: readonly string[];
  rows: readonly Row[];
}

/**
 * Two tables printed side by side and copied as one panel (HK Vitals, 2026-11-06: "Nutrients | Qty/Serving(8g) |
 * Qty./100g | %RDA*" twice): the same headers twice over. Each row is split in its two halves, and the right-hand
 * table is read after the left, so neither half's rows are lost under the other's columns.
 */
export function sideBySide<Row extends { cells: string[] }>(panel: Panel<Row>): Panel<Row> {
  const headers = panel.columnHeaders;
  const half = headers.length / 2;
  // Footnote marks may differ between the halves ("%RDA*" | "%RDA^", HK Vitals 2026-11-06 re-read).
  const key = (cells: readonly string[]) =>
    cells.map((cell) => cell.replace(/[\s*^#†‡]+/gu, "").toLowerCase());
  const twice =
    half >= 2 &&
    Number.isInteger(half) &&
    key(headers.slice(0, half)).join("|") === key(headers.slice(half)).join("|") &&
    panel.rows.every((row) => row.cells.length === headers.length);
  if (!twice) {
    return panel;
  }
  const side = (from: number) =>
    panel.rows
      .map((row) => ({ ...row, cells: row.cells.slice(from, from + half) }))
      .filter((row) => row.cells.some((cell) => cell.trim()));
  return { columnHeaders: headers.slice(0, half), rows: [...side(0), ...side(half)] };
}
