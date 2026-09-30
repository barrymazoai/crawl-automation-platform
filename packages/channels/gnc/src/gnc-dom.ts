import { DomUtils, parseDocument } from "htmlparser2";
import { gncPageErrors } from "./gnc-page-errors.js";

export type Document = ReturnType<typeof parseDocument>;
export type Element = Extract<ReturnType<typeof DomUtils.findOne>, object>;
type AnyNode = Document["children"][number];

/** Limits of one GNC product page: larger or deeper pages are refused, never truncated. */
export const GNC_PAGE_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxNodes: 100000,
  maxDepth: 128,
});

const HIDDEN = new Set(["script", "style", "template", "noscript"]);

/** Every element and text node counts toward the node limit; nesting deeper than the depth limit is refused. */
function checkSize(document: Document): void {
  let nodes = 0;
  const walk = (children: readonly AnyNode[], depth: number) => {
    for (const child of children) {
      const tag = DomUtils.isTag(child);
      nodes += child.type === "text" || tag ? 1 : 0;
      if (nodes > GNC_PAGE_LIMITS.maxNodes || (tag && depth > GNC_PAGE_LIMITS.maxDepth)) {
        throw gncPageErrors.create("GNC.PAGE_LIMIT");
      }
      if (DomUtils.isTag(child)) {
        walk(child.children, depth + 1);
      }
    }
  };
  walk(document.children, 1);
}

/** The page as a document whose elements keep their exact source positions (for slicing original HTML). */
export function gncDocument(html: string): Document {
  if (Buffer.byteLength(html) > GNC_PAGE_LIMITS.maxBytes) {
    throw gncPageErrors.create("GNC.PAGE_LIMIT");
  }
  const document = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  checkSize(document);
  return document;
}

/** What a visitor reads: text of the node, without scripts, styles and templates. */
export function visibleText(node: AnyNode | Document): string {
  if (node.type === "text") {
    return node.data;
  }
  if (!DomUtils.hasChildren(node) || (DomUtils.isTag(node) && HIDDEN.has(node.name))) {
    return "";
  }
  return node.children.map(visibleText).join(" ");
}

export const cleanText = (text: string) => text.replace(/\s+/g, " ").trim();

export const allElements = (document: Document): Element[] =>
  DomUtils.findAll(() => true, document.children);

/** Whether the element or one of its ancestors matches. */
export function within(element: Element, predicate: (candidate: Element) => boolean): boolean {
  let current: Element | null = element;
  while (current) {
    if (predicate(current)) {
      return true;
    }
    current = current.parent && DomUtils.isTag(current.parent) ? current.parent : null;
  }
  return false;
}

export const hasClass = (element: Element, name: string) =>
  (element.attribs.class ?? "").split(/\s+/).includes(name);

export const isHidden = (element: Element) => HIDDEN.has(element.name);

/** The element's exact original HTML, including its own tags. */
export const sourceOf = (html: string, element: Element) =>
  html.slice(element.startIndex ?? 0, (element.endIndex ?? html.length - 1) + 1);

/** A real challenge page (not a library that merely mentions a captcha) is refused. */
export function refuseChallenge(document: Document, elements: Element[]): void {
  const body = cleanText(visibleText(document));
  const denied =
    /Access to this page has been denied|Pardon Our Interruption|Press\s*(?:&|and)\s*Hold/i;
  const captcha = elements.some((element) =>
    ["px-captcha", "_pxCaptcha"].includes(element.attribs.id ?? ""),
  );
  if (denied.test(body) || captcha) {
    throw gncPageErrors.create("GNC.ACCESS_CHALLENGE");
  }
}
