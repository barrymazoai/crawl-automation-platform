import type { ParsedPanel } from "../../label/transcript/transcript-rows.js";

type Field = { text: string; evidence: string };
interface Column<Row extends { name: Field; parentRowIndex: number | null }> {
  heading: Field | null;
  dailyValueHeading?: Field;
  rows: Row[];
}
export interface PanelRead<Row extends { name: Field; parentRowIndex: number | null }> {
  parsed: ParsedPanel;
  column: Column<Row>;
}

const key = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Owner 2026-11-07 (India market rules): two panels of one label read as one formula, the first panel's rows then the
 * second's, each row read under its own panel's columns. Null when the second panel mostly repeats the first (the
 * model copied one table twice, Carbamide Forte multivitamin 2026-11-06): that copy is not read by the copy rules.
 */
export function joinPanelReads<Row extends { name: Field; parentRowIndex: number | null }>(
  first: PanelRead<Row>,
  second: PanelRead<Row>,
): PanelRead<Row> | null {
  const firstNames = new Set(first.column.rows.map((row) => key(row.name.text)));
  const secondNames = second.column.rows.map((row) => key(row.name.text));
  const repeated = secondNames.filter((name) => firstNames.has(name)).length;
  if (!secondNames.length || repeated * 2 >= secondNames.length) {
    return null;
  }
  const offset = first.column.rows.length;
  const moved = second.column.rows.map((row) => ({
    ...row,
    parentRowIndex: row.parentRowIndex === null ? null : row.parentRowIndex + offset,
  }));
  const dailyValueHeading = first.column.dailyValueHeading ?? second.column.dailyValueHeading;
  return {
    parsed: {
      ...first.parsed,
      rows: [...first.parsed.rows, ...second.parsed.rows],
      servingSize: first.parsed.servingSize ?? second.parsed.servingSize,
      servingsPerContainer: first.parsed.servingsPerContainer ?? second.parsed.servingsPerContainer,
    },
    column: {
      heading: first.column.heading ?? second.column.heading,
      ...(dailyValueHeading ? { dailyValueHeading } : {}),
      rows: [...first.column.rows, ...moved],
    },
  };
}
