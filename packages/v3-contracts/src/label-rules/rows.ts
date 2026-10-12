import type { LabelCandidate } from "../label-extraction.js";

export type LabelRow = NonNullable<LabelCandidate["formula"]>["columns"][number]["rows"][number];

/** A row rule sees its row and the column it sits in (parents point to earlier rows of the same column). */
export interface RowSubject {
  rows: readonly LabelRow[];
  index: number;
}

export const rowName = (row: LabelRow) => `"${row.name.text.slice(0, 80)}"`;
