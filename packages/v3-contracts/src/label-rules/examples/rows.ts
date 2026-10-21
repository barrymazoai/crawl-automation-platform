import type { LabelImageCandidate } from "../../label-extraction.js";

type LabelRow = NonNullable<LabelImageCandidate["formula"]>["columns"][number]["rows"][number];

type Kind = LabelRow["kind"];
/** [kind, parent, name, amount] — the stored answer's fields that rules read, written compactly. */
export type CompactRow = [Kind, number | null, string, string?];

const field = (text: string) => ({ text, evidence: text });

export function column(rows: CompactRow[]): LabelRow[] {
  return rows.map(([kind, parent, name, amount]) => ({
    kind,
    name: field(name),
    amount: amount ? field(amount) : null,
    dailyValue: null,
    amountStatus: amount ? "printed" : kind === "group_header" ? "not_applicable" : "not_declared",
    parentRowIndex: parent,
  }));
}

/** One blend component row in a minimal blend, for row rules that read only that row. */
export function component(name: string, amount?: string) {
  const row: CompactRow = amount ? ["blend_component", 0, name, amount] : ["blend_component", 0, name];
  return { rows: column([["blend_total", null, "Blend", "500 mg"], row]), index: 1 };
}
