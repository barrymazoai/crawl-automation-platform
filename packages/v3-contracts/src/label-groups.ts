import type { LabelCandidate, LabelFinding } from "./label-extraction.js";

type Row = NonNullable<LabelCandidate["formula"]>["columns"][number]["rows"][number];

const isGroup = (row: Row) => row.kind === "group_header" || row.kind === "blend_total";

/** Parents must precede children: this also rejects self-links and every possible cycle. */
function validParent(rows: readonly Row[], index: number, openGroups: readonly number[]): boolean {
  const row = rows[index]!;
  const parentIndex = row.parentRowIndex;
  if (parentIndex === null) {
    return row.kind !== "blend_component";
  }
  const parent = rows[parentIndex];
  if (!parent || parentIndex >= index || !openGroups.includes(parentIndex)) {
    return false;
  }
  return row.kind === "blend_component"
    ? isGroup(parent)
    : row.kind === "blend_total" && parent.kind === "blend_total";
}

/** Returning to an ancestor closes its nested group; a new root closes the previous tree. */
function advanceGroups(openGroups: number[], row: Row, index: number): void {
  const parentDepth = row.parentRowIndex === null ? -1 : openGroups.indexOf(row.parentRowIndex);
  openGroups.splice(parentDepth + 1);
  if (isGroup(row)) {
    openGroups.push(index);
  }
}

/** Kept as warnings: a printed blend amount without listed components, and a heading read as a group. */
const RETAINED = new Set(["LABEL.BLEND_WITHOUT_COMPONENTS", "LABEL.GROUP_HEADING_ONLY"]);

function emptyGroup(row: Row, index: number): LabelFinding {
  const standalone = row.kind === "blend_total" && row.amountStatus === "printed" && row.amount;
  // Owner 2026-10-07: "One Capsule Contains:", "KEY INGREDIENTS" and similar headings read as an empty group keep
  // the label; the rows under them are already standalone. A blend total without components stays a gap.
  const heading = row.kind === "group_header" && !row.amount;
  return {
    code: standalone
      ? "LABEL.BLEND_WITHOUT_COMPONENTS"
      : heading
        ? "LABEL.GROUP_HEADING_ONLY"
        : "LABEL.GROUP_EMPTY",
    detail: `row ${index} "${row.name.text.slice(0, 80)}": ${row.kind} has no components`,
  };
}

/** Validate column-local group trees without inventing missing parent links or component rows. */
export function assessLabelGroups(rows: readonly Row[]) {
  const findings: LabelFinding[] = [];
  const warnings: LabelFinding[] = [];
  const openGroups: number[] = [];
  const parentsWithChildren = new Set<number>();
  rows.forEach((row, index) => {
    if (!validParent(rows, index, openGroups)) {
      findings.push({
        code: "LABEL.PARENT_INVALID",
        detail: `row ${index} "${row.name.text.slice(0, 80)}": invalid parent ${row.parentRowIndex}`,
      });
    } else if (row.parentRowIndex !== null) {
      parentsWithChildren.add(row.parentRowIndex);
    }
    advanceGroups(openGroups, row, index);
  });
  rows.forEach((row, index) => {
    if (!isGroup(row) || parentsWithChildren.has(index)) {
      return;
    }
    const finding = emptyGroup(row, index);
    const target = RETAINED.has(finding.code) ? warnings : findings;
    target.push(finding);
  });
  return { findings, warnings };
}
