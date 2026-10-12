import type { LabelCandidate, LabelFinding } from "./label-extraction.js";
import { parentRule } from "./label-rules/parent.js";
import { applyLabelRules } from "./label-rules/rule.js";

type Row = NonNullable<LabelCandidate["formula"]>["columns"][number]["rows"][number];

const isGroup = (row: Row) => row.kind === "group_header" || row.kind === "blend_total";

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
  const parentsWithChildren = new Set<number>();
  rows.forEach((row, index) => {
    const finding = applyLabelRules([parentRule], { rows, index })[0];
    if (finding) {
      findings.push(finding);
    } else if (row.parentRowIndex !== null) {
      parentsWithChildren.add(row.parentRowIndex);
    }
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
