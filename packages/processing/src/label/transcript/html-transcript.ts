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
  const rows = tableRows(body) ?? gridRows(body);
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
    rows.push({ cells: texts, indent: indentOf(cells[0]), bold: header || hasBold(cells[0]) });
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
    rows.push({ cells, indent: indentOf(kids[0]), bold });
  }
  return rows.length >= 2 ? rows : null;
}

/** 2-4 column children: column-like class names, or a row class whose children hold no further rows. */
function isGridRow(el: Element, kids: Element[]): boolean {
  if (kids.length < 2 || kids.length > 4) {
    return false;
  }
  return (
    kids.every((kid) => COLUMN_CLASS.test(kid.className ?? "")) ||
    (/row/i.test(el.className ?? "") && kids.every((kid) => !kid.querySelector("div div")))
  );
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
  for (const el of Array.from(
    body.querySelectorAll("p, div, span, strong, b, h2, h3, h4, h5, h6, dt, li, td, th"),
  )) {
    const own = clean(el.textContent);
    if (!OTHER.test(own) || own.length > 2000) {
      continue;
    }
    const rest = own.replace(OTHER, "").trim();
    if (rest) {
      return rest;
    }
    const next = el.nextElementSibling ?? el.parentElement?.nextElementSibling;
    const text = clean(next?.textContent);
    if (text) {
      return text;
    }
  }
  return null;
}
