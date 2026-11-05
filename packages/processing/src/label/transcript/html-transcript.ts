import { parseHTML } from "linkedom";

/**
 * Owner 2026-11-04 (KAN-253 follow-up, docs/spark/2026-11-04-label-transcribe-then-parse-plan.md): a facts panel
 * that the page prints as a structure is COPIED first, nothing interpreted. Each printed row keeps its cells in
 * order (name, every amount column, every %DV column), its indentation and whether it is a heading.
 */
export interface TranscriptRow {
  cells: string[];
  indent: number;
  bold: boolean;
  /** The table (or grid container) the row belongs to, numbered in page order. */
  table: number;
  /**
   * KAN-243: which value cell (0 = the first cell after the name) is the amount and which the percentage, when a label
   * format read them from the printed column headers. Absent: decided from each cell's own text, as always.
   */
  columns?: { amount: number | null; dailyValue: number | null };
}

export interface HtmlTranscript {
  rows: TranscriptRow[];
  /** The Other Ingredients text after its heading, as printed. */
  otherIngredients: string | null;
}

interface Element {
  tagName: string;
  className?: string;
  children: ArrayLike<Element>;
  textContent: string | null;
  innerHTML: string;
  parentElement: Element | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): ArrayLike<Element>;
  contains(other: Element): boolean;
  nextElementSibling: Element | null;
  closest(selector: string): Element | null;
}

/** Numbers each distinct container in the order first seen. */
function numbering() {
  const seen: Element[] = [];
  return (container: Element | null) => {
    const at = container ? seen.indexOf(container) : -1;
    return at >= 0 ? at : seen.push(container as Element) - 1;
  };
}

const clean = (text: string | null | undefined) =>
  (text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const OTHER = /^(?:other|inactive)\s+ingredients?\s*:?/i;
const COLUMN_CLASS = /col|cell|amount|dv|value|name|label|qty/i;
const MAX_ROWS = 400;

/** The panel's rows from its own markup; `null` when the page prints no row structure (prose, an image). */
export function htmlTranscript(html: string): HtmlTranscript | null {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body as unknown as Element;
  const rows = tableRows(body) ?? gridRows(body) ?? preRows(body);
  if (!rows?.length) {
    return null;
  }
  return { rows: rows.slice(0, MAX_ROWS), otherIngredients: otherIngredients(body) };
}

/** `<table>`: one `<tr>` per row. A `<th scope="row">` names an ingredient; column headers make header rows. */
function tableRows(body: Element): TranscriptRow[] | null {
  const trs = Array.from(body.querySelectorAll("tr"));
  if (!trs.length) {
    return null;
  }
  const rows: TranscriptRow[] = [];
  const tableOf = numbering();
  for (const tr of trs) {
    const cells = Array.from(tr.children).filter((cell) => /^(?:td|th)$/i.test(cell.tagName));
    const texts = cells.map((cell) => clean(cell.textContent));
    if (!texts.some(Boolean)) {
      continue;
    }
    const header = cells.some(
      (cell) =>
        cell.tagName.toUpperCase() === "TH" &&
        (cell.getAttribute("scope") === "col" ||
          cell.getAttribute("scope") === "colgroup" ||
          tr.parentElement?.tagName.toUpperCase() === "THEAD"),
    );
    rows.push({
      cells: texts,
      indent: indentOf(cells[0]),
      bold: header || hasBold(cells[0]),
      table: tableOf(tr.closest("table")),
    });
  }
  return rows.length ? rows : null;
}

/**
 * Div grids: an element whose 2-4 direct children are its columns (column-like class names, or a row class whose
 * children hold no further rows). Nested matches keep only the outermost row.
 */
function gridRows(body: Element): TranscriptRow[] | null {
  const taken: Element[] = [];
  const rows: TranscriptRow[] = [];
  const gridOf = numbering();
  for (const el of Array.from(body.querySelectorAll("div, li, p, dl"))) {
    const kids = Array.from(el.children);
    if (!isGridRow(el, kids) || taken.some((row) => row.contains(el) || el.contains(row))) {
      continue;
    }
    const cells = kids.map((kid) => clean(kid.textContent));
    if (!cells.some(Boolean)) {
      continue;
    }
    taken.push(el);
    const bold = kids.some((kid) => hasBold(kid)) && !/\d/.test(cells.slice(1).join(""));
    rows.push({ cells, indent: indentOf(kids[0]), bold, table: gridOf(el.parentElement) });
  }
  return rows.length >= 2 ? rows : null;
}

/**
 * 2-4 cells that hold no blocks of their own (a container whose children are "flex-col" boxes is not a row), with
 * column-like class names, or under a row class or a CSS grid row ("grid grid-cols-[55%_1fr_1fr]", natrol 2026-11-04).
 */
function isGridRow(el: Element, kids: Element[]): boolean {
  if (kids.length < 2 || kids.length > 4 || kids.some((kid) => kid.querySelector(BLOCK))) {
    return false;
  }
  return (
    kids.every((kid) => COLUMN_CLASS.test(kid.className ?? "")) ||
    /row|\bgrid\b|grid-cols/i.test(el.className ?? "")
  );
}

const BLOCK = "div, p, li, ul, ol, table, tr, section";

const AMOUNT_HEADER = /^amount\s+per\s+serving\b/i;
const SERVING = /^servings?\s*(?:size|per\s+container)\b/i;
const PRE_UNIT = String.raw`(?:mcg|µg|μg|mg|g|kg|iu|ml|cfu|billion(?:\s+cfu)?|million(?:\s+cfu)?|kcal)`;
/** "Vitamin B-12 (as Cyanocobalamin) 1,000 mcg": the name, then the amount it ends with. */
const PRE_AMOUNT = new RegExp(
  String.raw`^(.*\S)\s+(<?\s*\d[\d,]*(?:\.\d+)?\s*${PRE_UNIT}(?:\s*(?:dfe|rae))?)$`,
  "i",
);
const PRE_CALORIES = /^(calories)\s+(\d[\d,]*)$/i;

/**
 * A panel printed as plain text (Swanson's <pre>): the serving lines, then from "Amount Per Serving" one row per
 * line until the first blank line, each line "name amount<TAB>%DV".
 */
function preRows(body: Element): TranscriptRow[] | null {
  const rows: TranscriptRow[] = [];
  Array.from(body.querySelectorAll("pre")).forEach((pre, table) => {
    const lines = (pre.textContent ?? "").replace(/\u00a0/g, " ").split(/\r?\n/);
    const header = lines.findIndex((line) => AMOUNT_HEADER.test(line.trim()));
    if (header < 0) {
      return;
    }
    for (const line of lines.slice(0, header).filter((text) => SERVING.test(text.trim()))) {
      rows.push({ cells: [clean(line)], indent: 0, bold: false, table });
    }
    const end = lines.findIndex((line, at) => at > header && !line.trim());
    for (const line of lines.slice(header + 1, end < 0 ? undefined : end)) {
      rows.push({ cells: preCells(line), indent: preIndent(line), bold: false, table });
    }
  });
  return rows.length ? rows : null;
}

function preCells(line: string): string[] {
  const [first = "", ...rest] = line.split("\t").map(clean);
  const split = PRE_AMOUNT.exec(first) ?? PRE_CALORIES.exec(first);
  return split?.[1] && split[2] ? [split[1], split[2], ...rest] : [first, ...rest];
}

function preIndent(line: string): number {
  return Math.floor((/^[ \t]*/.exec(line)?.[0].length ?? 0) / 2);
}

function hasBold(el: Element | undefined): boolean {
  return !!el && (/^(?:b|strong|th)$/i.test(el.tagName) || !!el.querySelector("b, strong"));
}

/** Indentation from leading non-breaking spaces, an indent/level/sub class, or a left padding/margin style. */
function indentOf(el: Element | undefined): number {
  if (!el) {
    return 0;
  }
  const levels = [nbspIndent(el.innerHTML), classIndent(el.className ?? ""), styleIndent(el)];
  return Math.min(8, Math.max(...levels));
}

function nbspIndent(html: string): number {
  const leading = /^(?:\s|&nbsp;|\u00a0)*/.exec(html)?.[0] ?? "";
  return Math.floor((leading.match(/&nbsp;|\u00a0/g) ?? []).length / 2);
}

function classIndent(className: string): number {
  const level = /(?:indent|level|sub|child)-?(\d)?/i.exec(className);
  return level ? Number(level[1] ?? 1) : 0;
}

function styleIndent(el: Element): number {
  const style = /(?:padding|margin)-left:\s*(\d+(?:\.\d+)?)(px|em|rem)?/i.exec(
    el.getAttribute("style") ?? "",
  );
  if (!style) {
    return 0;
  }
  return Math.round(Number(style[1]) / (style[2] === "em" || style[2] === "rem" ? 1 : 10));
}

function otherIngredients(body: Element): string | null {
  return preOtherIngredients(body) ?? elementOtherIngredients(body);
}

/** Swanson's plain-text panel prints "Other Ingredients: …" as one of its lines. */
function preOtherIngredients(body: Element): string | null {
  for (const pre of Array.from(body.querySelectorAll("pre"))) {
    const line = (pre.textContent ?? "").split(/\r?\n/).find((text) => OTHER.test(text.trim()));
    const rest = line ? clean(line).replace(OTHER, "").trim() : "";
    if (rest) {
      return rest;
    }
  }
  return null;
}

/** The heading's own element ("Other Ingredients: …"), else the element right after it. */
function elementOtherIngredients(body: Element): string | null {
  for (const el of Array.from(
    body.querySelectorAll("p, div, span, strong, b, h2, h3, h4, h5, h6, dt, li, td, th"),
  )) {
    const own = clean(el.textContent);
    if (!OTHER.test(own) || own.length > 2000) {
      continue;
    }
    const rest = own.replace(OTHER, "").trim();
    const next = el.nextElementSibling ?? el.parentElement?.nextElementSibling;
    const text = rest || clean(next?.textContent);
    if (text) {
      return text;
    }
  }
  return null;
}
