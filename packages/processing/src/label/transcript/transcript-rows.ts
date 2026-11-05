import type { TranscriptRow } from "./html-transcript.js";
import { memberDose, readCells, servingLine, type Cells } from "./transcript-cells.js";
import { memberRow, printedRow, type ParsedPanel, type ParsedRow } from "./transcript-row-build.js";

export type { ParsedPanel, ParsedRow } from "./transcript-row-build.js";

/** Commas and semicolons outside parentheses/brackets separate the items of a printed list. */
export function splitPrintedList(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text.replace(/\.\s*$/, "")) {
    depth = Math.max(0, depth + ("([{".includes(ch) ? 1 : 0) - (")]}".includes(ch) ? 1 : 0));
    if ((ch === "," || ch === ";") && depth === 0) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current.trim());
  return items.filter(Boolean);
}

/** Rows of one panel: serving lines, amount/%DV cells, blends from layout and the panels' printed conventions. */
export function parseTranscriptRows(rows: readonly TranscriptRow[]): ParsedPanel {
  const parser = new RowParser();
  for (const row of rows) {
    parser.read(row);
  }
  const panel = parser.panel;
  // A dosed "… Complex" row nothing is listed under ("Citrus Bioflavonoid Complex 60 mg") is one ingredient.
  panel.rows.forEach((row, index) => {
    if (row.kind === "blend_total" && !panel.rows.some((other) => other.parentRowIndex === index)) {
      row.kind = "nutrient";
    }
  });
  return panel;
}

interface OpenGroup {
  index: number;
  indent: number;
  printed: boolean;
}

class RowParser {
  readonly panel: ParsedPanel = { servingSize: null, servingsPerContainer: null, rows: [] };
  private readonly open: OpenGroup[] = [];
  /** Blend members whose dose is printed before their name; that dose never keeps the blend open. */
  private readonly listed = new Set<number>();

  read(raw: TranscriptRow): void {
    if (this.servingLine(raw)) {
      return;
    }
    const cells = readCells(raw);
    if (!cells) {
      return;
    }
    this.closeByLayout(raw.indent);
    if (this.componentList(cells) || this.inlineBlend(cells)) {
      return;
    }
    this.row(cells);
  }

  private servingLine(raw: TranscriptRow): boolean {
    const line = servingLine(raw);
    if (line?.field === "servingSize") {
      this.panel.servingSize ??= line.value;
    } else if (line) {
      this.panel.servingsPerContainer ??= line.value;
    }
    return !!line;
  }

  /** A row at or left of an open group's indent closes it (only when the panel indents at all). */
  private closeByLayout(indent: number): void {
    while (indent > 0 && (this.top()?.indent ?? -1) >= indent) {
      this.open.pop();
    }
  }

  /** An undosed comma list indented under an open group, or right below it, lists that group's components. */
  private componentList(cells: Cells): boolean {
    const parts = splitPrintedList(cells.name);
    if (cells.amount || parts.length < 2) {
      return false;
    }
    const parent = this.top() ?? this.blendAbove(cells);
    // GNC prints a blend's list unindented in the row right below it ("Stimulant Complex 750 mg" / "Caffeine, …").
    const listsParent = cells.raw.indent > 0 || this.panel.rows.length - 1 === parent?.index;
    if (!listsParent || !parent) {
      return false;
    }
    for (const part of parts) {
      this.component(part, parent.index);
    }
    return true;
  }

  /**
   * Owner 2026-11-05 (Iron Faith Essential Cell Food: "Health Support 170 mg **" over "Lutein, Lycopene …, Saw
   * Palmetto"): a dosed root row without a %DV, right above a list printing no values of its own, is a blend named
   * without a blend word; the list is its components.
   */
  private blendAbove(cells: Cells): OpenGroup | undefined {
    const index = this.panel.rows.length - 1;
    const above = this.panel.rows[index];
    const blend =
      above?.kind === "nutrient" &&
      !!above.amount &&
      above.dailyValue === null &&
      above.parentRowIndex === null &&
      cells.valuesBlank;
    if (!above || !blend) {
      return undefined;
    }
    above.kind = "blend_total";
    const group = { index, indent: cells.raw.indent, printed: true };
    this.open.push(group);
    return group;
  }

  /** "Blend Name: A, B (part), C" in one cell: the blend and its components. */
  private inlineBlend(cells: Cells): boolean {
    const inline = /^(.+?):\s+(.+)$/.exec(cells.nameCell);
    const parts = inline?.[2] ? splitPrintedList(inline[2]) : [];
    if (!inline?.[1] || parts.length < 2 || /^serving/i.test(inline[1])) {
      return false;
    }
    this.open.length = 0;
    const blend = this.push({
      kind: cells.amount ? "blend_total" : "group_header",
      name: inline[1].trim(),
      amount: cells.amount,
      dailyValue: cells.dailyValue,
      parentRowIndex: null,
      ...(cells.dvMarker ? { dailyValueMarker: cells.dvMarker } : {}),
    });
    for (const part of parts) {
      this.component(part, blend);
    }
    return true;
  }

  private component(text: string, parentRowIndex: number): void {
    const dosed = memberDose(text);
    const index = this.push({
      kind: "blend_component",
      name: dosed?.name ?? text,
      amount: dosed?.amount ?? null,
      dailyValue: null,
      parentRowIndex,
    });
    this.listed.add(index);
  }

  private row(cells: Cells): void {
    this.closeAfterDosedRoot(cells);
    const isGroup = (cells.endsWithColon || cells.groupWord) && cells.valuesBlank;
    if (isGroup) {
      this.makeRoomForGroup(cells);
    }
    const parentRowIndex = this.parent();
    const member = isGroup ? null : memberRow(cells, parentRowIndex);
    const index = this.push({
      ...printedRow(cells, isGroup, parentRowIndex),
      ...(member ?? {}),
    });
    if (member) {
      this.listed.add(index);
    }
    if (isGroup) {
      this.open.push({ index, indent: cells.raw.indent, printed: !!cells.amount });
    }
  }

  /** A dosed root row after a blend's undosed (or listed) components closes the blend. */
  private closeAfterDosedRoot(cells: Cells): void {
    const top = this.top();
    if (!top || !cells.amount || cells.raw.indent > 0 || cells.endsWithColon || cells.groupWord) {
      return;
    }
    const after = this.panel.rows.slice(top.index + 1);
    if (after.every((row, at) => row.amount === null || this.listed.has(top.index + 1 + at))) {
      this.open.length = 0;
    }
  }

  /** An undosed sub-heading ends the previous undosed one (siblings in one blend); a dosed root blend ends all. */
  private makeRoomForGroup(cells: Cells): void {
    if (cells.amount && cells.raw.indent === 0) {
      this.open.length = 0;
      return;
    }
    while (!cells.amount && this.open.length > 1 && !this.top()?.printed) {
      this.open.pop();
    }
  }

  /**
   * A row's blend: the innermost dosed blend still open ("Lactobacilli Blend:" under a 30 Billion CFU blend is a
   * sub-heading, and its strains belong to the dosed total), else the innermost open heading.
   */
  private parent(): number | null {
    const dosed = this.open.findLast((group) => group.printed);
    return (dosed ?? this.top())?.index ?? null;
  }

  private top(): OpenGroup | undefined {
    return this.open[this.open.length - 1];
  }

  private push(row: ParsedRow): number {
    return this.panel.rows.push(row) - 1;
  }
}
