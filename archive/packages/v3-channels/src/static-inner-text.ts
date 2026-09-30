/**
 * `innerText` for a static HTML document (no layout engine), following the rendering rules of the HTML standard's
 * innerText algorithm for the elements product pages use: paragraphs are separated by a blank line, other block
 * elements and table rows start on their own line, table cells are separated by a tab, `<br>` is a line break, and
 * runs of whitespace collapse to one space. Hidden elements (`hidden`, `aria-hidden="true"`) contribute nothing.
 *
 * Without this, a DOM library without layout returns the raw text: table rows run together on one line, which is not
 * what a visitor (or the browser capture) reads, and line-anchored label checks fail.
 */

/** Items are text, or a required line-break count (the standard's "required line break count"). */
type Item = string | number;

const PARAGRAPH = new Set(["p"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "caption", "details", "dialog", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "li", "main", "nav", "ol", "pre", "section", "summary", "table", "tr", "ul",
]);
const CELL = new Set(["td", "th"]);
const SKIPPED = new Set(["script", "style", "noscript", "template", "head"]);

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  nextElementSibling?: DomNode | null;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function isHidden(element: DomNode): boolean {
  return Boolean(element.hasAttribute?.("hidden")) || element.getAttribute?.("aria-hidden") === "true";
}

function collect(node: DomNode, items: Item[]): void {
  if (node.nodeType === TEXT_NODE) {
    items.push((node.textContent ?? "").replace(/[ \t\n\r\f]+/g, " "));
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return;
  }
  const tag = node.nodeName.toLowerCase();
  if (SKIPPED.has(tag) || isHidden(node)) {
    return;
  }
  if (tag === "br") {
    items.push("\n");
    return;
  }
  const breaks = PARAGRAPH.has(tag) ? 2 : BLOCK.has(tag) ? 1 : 0;
  if (breaks) items.push(breaks);
  for (const child of Array.from(node.childNodes)) collect(child, items);
  if (breaks) items.push(breaks);
  const next = node.nextElementSibling?.nodeName.toLowerCase();
  if (CELL.has(tag) && next && CELL.has(next)) items.push("\t");
}

/** Joins the items: consecutive break counts become that many newlines (the largest wins), none at either end. */
function render(items: Item[]): string {
  let text = "";
  let pending = 0;
  for (const item of items) {
    if (typeof item === "number") {
      pending = Math.max(pending, item);
      continue;
    }
    if (!item) continue;
    if (pending && text) text = text.replace(/ +$/, "") + "\n".repeat(pending);
    pending = 0;
    text += text.endsWith("\n") ? item.replace(/^ +/, "") : item;
  }
  // A <br> that ends a block draws no extra line in a browser, so at most one blank line remains.
  return text
    .replace(/ {2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/ *\t */g, "\t")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \n]+|[ \n]+$/g, "");
}

export function staticInnerText(element: DomNode): string {
  const items: Item[] = [];
  for (const child of Array.from(element.childNodes)) collect(child, items);
  return render(items);
}
