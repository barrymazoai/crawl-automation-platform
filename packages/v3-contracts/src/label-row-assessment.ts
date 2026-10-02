import type { LabelCandidate, LabelFinding } from "./label-extraction.js";
import { assessLabelGroups } from "./label-groups.js";

type Row = NonNullable<LabelCandidate["formula"]>["columns"][number]["rows"][number];
const rowText = (row: Row, index: number) =>
  `row ${index} "${row.name.text.slice(0, 80)}"${row.amount ? ` amount "${row.amount.text.slice(0, 30)}"` : ""}`;

/** Existing row checks shared by every extraction protocol; never repair a missing dose. */
export function assessLabelRows(rows: Row[]) {
  const result = assessLabelGroups(rows);
  rows.forEach((row, index) => {
    const detail = rowText(row, index);
    result.findings.push(...amountFindings(row, detail));
    const parent = row.parentRowIndex === null ? undefined : rows[row.parentRowIndex];
    if (row.amountStatus !== "not_declared") {
      return;
    }
    if (row.kind === "blend_component") {
      if (parent?.kind !== "blend_total") {
        result.findings.push({
          code: "LABEL.AMOUNT_MISSING",
          detail: `${detail}: component without amount outside a blend total`,
        });
      }
    } else if (row.kind !== "group_header") {
      result.findings.push({
        code: "LABEL.AMOUNT_MISSING",
        detail: `${detail}: no amount${row.dailyValue ? ` (label prints only %DV "${row.dailyValue.text}")` : ""}`,
      });
    }
  });
  return result;
}

function amountFindings(row: Row, detail: string): LabelFinding[] {
  const findings: LabelFinding[] = [];
  const flag = (code: string, message: string) =>
    findings.push({ code, detail: `${detail}: ${message}` });
  if ((row.amountStatus === "printed") !== (row.amount !== null)) {
    flag(
      "LABEL.AMOUNT_STATE_CONFLICT",
      `status ${row.amountStatus} but amount ${row.amount ? "present" : "missing"}`,
    );
  }
  const header = headerFinding(row, detail);
  if (header) {
    findings.push(header);
  }
  if (row.amountStatus === "unreadable") {
    flag("LABEL.AMOUNT_UNREADABLE", "amount unreadable");
  }
  return findings;
}

function headerFinding(row: Row, detail: string): LabelFinding | null {
  if (row.kind === "group_header") {
    return row.amountStatus !== "not_applicable" || row.amount !== null || row.dailyValue !== null
      ? { code: "LABEL.HEADER_VALUE_CONFLICT", detail: `${detail}: a group header carries a value` }
      : null;
  }
  return row.amountStatus === "not_applicable"
    ? {
        code: "LABEL.AMOUNT_STATE_CONFLICT",
        detail: `${detail}: ${row.kind} marked not_applicable${row.dailyValue ? ` (label prints only %DV "${row.dailyValue.text}")` : ""}`,
      }
    : null;
}
