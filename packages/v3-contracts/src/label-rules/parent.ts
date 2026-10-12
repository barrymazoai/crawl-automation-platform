import type { LabelRule } from "./rule.js";
import { rowName, type LabelRow, type RowSubject } from "./rows.js";

const isGroup = (row: LabelRow) => row.kind === "group_header" || row.kind === "blend_total";

const printedBlend = (row: LabelRow) =>
  row.kind === "blend_total" && row.amountStatus === "printed" && row.amount !== null;

/**
 * A dose-free heading the model left without a parent while a printed blend is open ("Candidase® Enzyme Blend
 * 787.5 mg" / "Fiber-Digesting Enzyme" / "Cellulase …" pointing at the blend) is a sub-heading inside that blend.
 */
function subHeadingInBlend(rows: readonly LabelRow[], open: readonly number[], row: LabelRow): boolean {
  return (
    row.kind === "group_header" &&
    row.parentRowIndex === null &&
    !row.amount &&
    open.length > 0 &&
    printedBlend(rows[open[0]!]!)
  );
}

/** Groups still open before `index`: returning to an ancestor closes its nested groups; a new root closes the tree. */
export function openGroupsBefore(rows: readonly LabelRow[], index: number): number[] {
  const open: number[] = [];
  rows.slice(0, index).forEach((row, at) => {
    if (subHeadingInBlend(rows, open, row)) {
      open.push(at);
      return;
    }
    const depth = row.parentRowIndex === null ? -1 : open.indexOf(row.parentRowIndex);
    open.splice(depth + 1);
    if (isGroup(row)) open.push(at);
  });
  return open;
}

/** Parents must precede children: this also rejects self-links and every possible cycle. */
function validParent(rows: readonly LabelRow[], index: number): boolean {
  const row = rows[index]!;
  const parentIndex = row.parentRowIndex;
  if (parentIndex === null) return row.kind !== "blend_component";
  const parent = rows[parentIndex];
  if (!parent || parentIndex >= index || !openGroupsBefore(rows, index).includes(parentIndex)) return false;
  return row.kind === "blend_component"
    ? isGroup(parent)
    : row.kind === "blend_total" && parent.kind === "blend_total";
}

export const parentRule: LabelRule<RowSubject> = {
  id: "parent-is-open-earlier-group",
  code: "LABEL.PARENT_INVALID",
  added: "2026-10-12",
  why:
    "R51 (2026-09-30): a component's parent is an earlier, still-open group; blends may nest. 2026-10-12: a " +
    "dose-free sub-heading inside a printed blend no longer closes the blend — 176 of 411 stored answers were " +
    "rejected only for that (enzyme, probiotic and fatty-acid profile sub-headings).",
  check: ({ rows, index }) =>
    validParent(rows, index)
      ? null
      : `row ${index} ${rowName(rows[index]!)}: invalid parent ${rows[index]!.parentRowIndex}`,
};
