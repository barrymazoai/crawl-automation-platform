import { compile, type DomNode, type FormatCallback, type SelectorDefinition } from "html-to-text";

/** Elements that start on their own line (the HTML standard's block-level elements product pages use). */
const BLOCKS = [
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "details",
  "dialog",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "pre",
  "section",
  "summary",
  "table",
  "tr",
  "ul",
];
const SKIPPED = [
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "img",
  "[hidden]",
  '[aria-hidden="true"]',
];
const CELLS = new Set(["td", "th"]);

const LINE = { leadingLineBreaks: 1, trailingLineBreaks: 1 };

const isElement = (node: DomNode | undefined) => node?.type === "tag";
const isBlank = (node: DomNode) => node.type === "text" && !(node.data ?? "").trim();

/** The next sibling that is an element or holds text; whitespace between tags does not count. */
function nextContent(node: DomNode): DomNode | undefined {
  const siblings = node.parent?.children ?? [];
  return siblings.slice(siblings.indexOf(node) + 1).find((sibling) => !isBlank(sibling));
}

/** A table cell: its text, then a tab when another cell follows in the same row. */
const cell: FormatCallback = (elem, walk, builder) => {
  walk(elem.children, builder);
  const next = nextContent(elem);
  if (isElement(next) && CELLS.has(next?.name ?? "")) {
    builder.addLiteral("\t");
  }
};

/** A line break, except at the end of a block, where a browser draws no extra line. */
const lineBreak: FormatCallback = (elem, _walk, builder) => {
  if (nextContent(elem)) {
    builder.addLineBreak();
  }
};

const selectors: SelectorDefinition[] = [
  ...BLOCKS.map((selector) => ({ selector, format: "block", options: LINE })),
  { selector: "p", format: "block", options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } },
  { selector: "td", format: "cell" },
  { selector: "th", format: "cell" },
  { selector: "br", format: "lineBreakInText" },
  { selector: "a", format: "inline" },
  ...SKIPPED.map((selector) => ({ selector, format: "skip" })),
];

const convert = compile({
  wordwrap: false,
  whitespaceCharacters: " \t\n\r\f",
  formatters: { cell, lineBreakInText: lineBreak },
  selectors,
});

/**
 * What a visitor reads on a static HTML page (no layout engine), as `innerText` would give it: block elements and
 * table rows on their own lines, paragraphs separated by a blank line, table cells by a tab, `<br>` as a line break,
 * runs of whitespace as one space; scripts, images and hidden elements (`hidden`, `aria-hidden="true"`) left out.
 * html-to-text does the parsing and layout; only the cell and line-break rules are ours.
 */
export function pageText(html: string): string {
  return convert(html)
    .replace(/ *\t */g, "\t")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
