import { pageFailure } from "./page-errors.js";
import { pagePolicy } from "./page-input.js";

export interface PageCell {
  text: string;
  header: boolean;
  rowspan: number;
  colspan: number;
}

export interface PageTable {
  index: number;
  rows: PageCell[][];
}

interface OpenTable {
  table: PageTable;
  row: PageCell[] | null;
  cell: PageCell | null;
}

const omitted = new Set(["script", "style", "template", "noscript"]);
const blocks = new Set([
  ...["p", "div", "section", "article", "header", "footer", "li", "br", "tr", "td", "th", "table"],
  ...["h1", "h2", "h3", "h4", "h5", "h6"],
]);

/** Inline elements a div-built table uses as its cells. */
const rowItems = new Set(["span", "b", "strong", "i", "em", "small", "label"]);

const limit = () => pageFailure("PROCESSING.PAGE_LIMIT");

/** A cell span as written; `rowspan=0` (the remaining rows) is kept as it is, never expanded or guessed. */
function span(raw: string | undefined): number {
  if (raw === undefined) {
    return 1;
  }
  if (!/^\d+$/.test(raw) || Number(raw) > 1000) {
    throw limit();
  }
  return Number(raw);
}

/**
 * Collects a page's text and tables from the parser's events (htmlparser2 does the HTML parsing). Scripts, styles,
 * templates and noscript content are left out; block elements start new lines. Every limit is enforced as it goes.
 */
export class PageCollector {
  readonly parts: string[] = [];
  readonly tables: PageTable[] = [];
  private readonly skips: boolean[] = [];
  /** Open elements and whether each has had text of its own, for the row-of-cells rule. */
  private readonly names: string[] = [];
  private readonly ownText: boolean[] = [];
  /** The depth of a just-closed inline cell, until anything but whitespace or a sibling cell follows. */
  private closedCell: number | null = null;
  private readonly open: OpenTable[] = [];
  private depth = 0;
  private suppressed = 0;
  private nodes = 0;
  private cells = 0;
  private outputBytes = 0;

  openTag(name: string, attributes: Record<string, string>): void {
    this.nodes++;
    this.depth++;
    if (this.nodes > pagePolicy.maxNodes || this.depth > pagePolicy.maxDepth) {
      throw limit();
    }
    const skip = omitted.has(name);
    this.skips.push(skip);
    this.suppressed += skip ? 1 : 0;
    if (this.suppressed) {
      this.names.push(name);
      this.ownText.push(false);
      return;
    }
    this.separateCells(name);
    this.names.push(name);
    this.ownText.push(false);
    if (blocks.has(name)) {
      this.append("\n");
    }
    if (name === "table") {
      this.openTable();
    } else if (name === "tr") {
      this.openRow();
    } else if (name === "td" || name === "th") {
      this.openCell(name === "th", attributes);
    }
  }

  text(value: string): void {
    if (++this.nodes > pagePolicy.maxNodes) {
      throw limit();
    }
    if (!this.suppressed) {
      if (value.trim()) {
        this.closedCell = null;
        this.ownText[this.ownText.length - 1] = true;
      }
      this.append(value);
    }
  }

  closeTag(name: string): void {
    const skip = this.skips.pop();
    this.names.pop();
    this.ownText.pop();
    this.depth--;
    this.suppressed -= skip ? 1 : 0;
    if (this.suppressed || skip) {
      return;
    }
    this.closedCell = rowItems.has(name) ? this.depth : null;
    this.closeTableParts(name);
    if (blocks.has(name)) {
      this.append("\n");
    }
  }

  /**
   * Owner 2026-10-20: sibling inline elements that make up a block on their own are a row of cells and get a tab
   * between them. Div-built Facts panels (bloodsugarfriendly.com: `<div><span>Total Fat 8g</span><span>10%</span>`)
   * otherwise read "Total Fat 8g10%" and "Calories170". A block with text of its own is unchanged.
   */
  private separateCells(name: string): void {
    const parent = this.names.at(-1);
    const siblingCell =
      this.closedCell === this.depth - 1 &&
      rowItems.has(name) &&
      parent !== undefined &&
      blocks.has(parent) &&
      !this.ownText.at(-1);
    this.closedCell = null;
    if (siblingCell) {
      this.append("\t");
    }
  }

  /** A closed cell ends the open cell; a closed row also ends the row; a closed table leaves it. */
  private closeTableParts(name: string): void {
    const current = this.open.at(-1);
    if (current && (name === "td" || name === "th" || name === "tr")) {
      current.cell = null;
      current.row = name === "tr" ? null : current.row;
    }
    if (name === "table") {
      this.open.pop();
    }
  }

  private openTable(): void {
    if (this.tables.length >= pagePolicy.maxTables) {
      throw limit();
    }
    const table: PageTable = { index: this.tables.length, rows: [] };
    this.tables.push(table);
    this.open.push({ table, row: null, cell: null });
  }

  private openRow(): void {
    const current = this.open.at(-1);
    if (current) {
      current.row = [];
      current.table.rows.push(current.row);
      current.cell = null;
    }
  }

  private openCell(header: boolean, attributes: Record<string, string>): void {
    const current = this.open.at(-1);
    if (!current) {
      return;
    }
    if (++this.cells > pagePolicy.maxCells) {
      throw limit();
    }
    if (!current.row) {
      current.row = [];
      current.table.rows.push(current.row);
    }
    const rowspan = span(attributes["rowspan"]);
    const colspan = span(attributes["colspan"]);
    current.cell = { text: "", header, rowspan, colspan };
    current.row.push(current.cell);
  }

  /** Text goes to the page and to every open cell; each copy counts against the output limit. */
  private append(value: string): void {
    const openCells = this.open.filter((entry) => entry.cell).length;
    this.outputBytes += Buffer.byteLength(value) * (1 + openCells);
    if (this.outputBytes > pagePolicy.maxOutputBytes) {
      throw limit();
    }
    this.parts.push(value);
    for (const entry of this.open) {
      if (entry.cell) {
        entry.cell.text += value;
      }
    }
  }
}
