import { memberDose, type Cells } from "./transcript-cells.js";

/**
 * Step 2 of the transcribe-then-parse plan: a copied panel becomes formula rows by fixed rules, so the same panel
 * always gives the same structure. Every text a row carries is a substring of one transcript cell.
 */
export interface ParsedRow {
  kind: "nutrient" | "group_header" | "blend_total" | "blend_component";
  name: string;
  amount: string | null;
  dailyValue: string | null;
  parentRowIndex: number | null;
  /** A printed "no DV" marker cell ("--", "**", "†"): quoted as printed, never read as a value. */
  dailyValueMarker?: string;
  /** The same marker printed in the amount column: left out as noise, never an amount. */
  amountMarker?: string;
}

export interface ParsedPanel {
  servingSize: string | null;
  servingsPerContainer: string | null;
  rows: ParsedRow[];
}

/** A printed row as a formula row: its kind from its place in the panel, values as printed. */
export function printedRow(
  cells: Cells,
  isGroup: boolean,
  parentRowIndex: number | null,
): ParsedRow {
  return {
    kind: rowKind(isGroup, cells, parentRowIndex),
    name: cells.name,
    amount: cells.amount,
    dailyValue: cells.dailyValue,
    // A sub-heading's place inside a printed blend is the label rules' own reading; it carries no parent.
    parentRowIndex: isGroup && !cells.amount ? null : parentRowIndex,
    ...(cells.dvMarker ? { dailyValueMarker: cells.dvMarker } : {}),
    ...(cells.amountMarker ? { amountMarker: cells.amountMarker } : {}),
  };
}

/** A blend member on its own line printing its dose before its name ("300 mg Boswellia … (Boswellia serrata),"). */
export function memberRow(cells: Cells, parentRowIndex: number | null) {
  return !cells.amount && parentRowIndex !== null ? memberDose(cells.name) : null;
}

function rowKind(isGroup: boolean, cells: Cells, parentRowIndex: number | null): ParsedRow["kind"] {
  if (isGroup) {
    return cells.amount ? "blend_total" : "group_header";
  }
  return parentRowIndex !== null ? "blend_component" : "nutrient";
}
