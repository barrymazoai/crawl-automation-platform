import {
  allowedContent,
  labelCoreFailure,
  labelRange,
  pageText,
  type LabelCoreReader,
} from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_LENGTH = 200_000;

/** Shopify controls and the Solaray DTC coverage sample (2026-10-21). Keep this vocabulary at the reader boundary. */
const DTC_LABEL_CHROME = {
  containers:
    'nav, [role="navigation"], [role="dialog"], dialog, form, button, ' +
    'details, summary, .visually-hidden, .sr-only, [class*="breadcrumb"], [class*="share"], ' +
    '[class*="social"], [class*="faq"], [class*="accordion"], [class*="rating"]',
  faqHeading: /^(?:frequently asked questions|customers also ask)$/i,
  controlLine:
    /^(?:skip to .+|open media \d+ in modal|close|previous|next|\d+\s*\/\s*of\s*\d+|\d+(?:\.\d+)?\s+reviews?|highly rated(?: by customers(?: for)?)?:?|add to cart|buy now|sold out|quantity|(?:increase|decrease) quantity(?: for .+)?|regular price|sale price|unit price|share(?: on .+)?|copy link)$/i,
  labelMatter:
    /\b(?:supplement\s+facts|nutrition\s+facts|(?:other\s+)?ingredients?|serving\s+size)\b|\b\d+(?:[.,]\d+)?\s*(?:mcg|µg|mg|kg|g|ml|l|iu|capsules?|tablets?|softgels?|vegcaps?|scoops?|drops?|gummies?|packets?)\b/i,
} as const;

function labelMatter(text: string): boolean {
  return DTC_LABEL_CHROME.labelMatter.test(text);
}

function leadingHeading(node: Element): string {
  const first = node.firstElementChild;
  return first?.matches("h1, h2, h3, h4, summary, caption, [role='heading']")
    ? (first.textContent?.trim() ?? "")
    : "";
}

function faqContainer(node: Element): boolean {
  if (!node.matches("section, article, details, div")) {
    return false;
  }
  return DTC_LABEL_CHROME.faqHeading.test(leadingHeading(node));
}

function factsPanel(node: Element): boolean {
  if (!node.matches("section, article, details, div, table")) {
    return false;
  }
  return /^(?:supplement|nutrition)\s+facts\b/i.test(leadingHeading(node));
}

function chromeContainer(node: Element): boolean {
  return node.matches(DTC_LABEL_CHROME.containers) || faqContainer(node) || !allowedContent(node);
}

function labelParagraph(node: Element): boolean {
  const paragraph = node.matches("p, li, tr, td, th");
  const leafBlock =
    node.matches("div") && !node.querySelector("p, div, li, section, details, table");
  return (paragraph || leafBlock) && labelMatter(node.textContent ?? "");
}

/** Remove a whole chrome subtree only when it contains no label paragraph; otherwise prune its unrelated children. */
function pruneChrome(node: Element, inChrome = false): void {
  if (factsPanel(node)) {
    return;
  }
  const chrome = inChrome || chromeContainer(node);
  if (chrome && labelParagraph(node)) {
    return;
  }
  if (chrome && !labelMatter(node.textContent ?? "")) {
    node.remove();
    return;
  }
  for (const child of [...node.childNodes]) {
    pruneChromeChild(child, chrome);
  }
}

function pruneChromeChild(child: ChildNode, chrome: boolean): void {
  if (child.nodeType === 1) {
    pruneChrome(child as Element, chrome);
  } else if (chrome && child.nodeType === 3 && !labelMatter(child.textContent ?? "")) {
    child.parentNode?.removeChild(child);
  }
}

function withoutChromeLines(text: string): string {
  const lines = text.replace(/^\d+\n\/\nof\n\d+$/gm, "").split("\n");
  return lines
    .filter((line) => labelMatter(line) || !DTC_LABEL_CHROME.controlLine.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A single named ingredient panel has a DOM boundary even when the page has no Facts table. */
function ingredientPanel(root: Element): Element | null {
  const panels = [...root.querySelectorAll("h2, h3, h4, summary")]
    .map(ingredientHeadingPanel)
    .filter((panel): panel is Element => panel !== null);
  return panels.length === 1 ? (panels[0] ?? null) : null;
}

function ingredientHeadingPanel(heading: Element): Element | null {
  if (
    !/^(?:(?:plant[- ]based|other)\s+)?ingredients\s*:?$/i.test(heading.textContent?.trim() ?? "")
  ) {
    return null;
  }
  return boundedIngredientParent(heading);
}

function boundedIngredientParent(heading: Element): Element | null {
  const parent = heading.parentElement;
  const body = heading.nextElementSibling;
  if (!parent || !body) {
    return null;
  }
  if (
    !parent.matches("section, article, details, div") ||
    parent.firstElementChild !== heading ||
    parent.children.length !== 2
  ) {
    return null;
  }
  return body.matches("section, article, div, ul, p") && body.textContent?.trim() ? parent : null;
}

function labelPageText(html: string): string {
  // The channel plan supplies an HTML fragment; wrapping it gives linkedom a stable body for DOM pruning.
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const child of [...document.body.children]) {
    pruneChrome(child);
  }
  const full = withoutChromeLines(pageText(document.body.innerHTML, { rowCells: true }));
  if (labelRange(full)) {
    return full;
  }
  const panel = ingredientPanel(document.body);
  return panel ? withoutChromeLines(pageText(panel.innerHTML, { rowCells: true })) : full;
}

/**
 * Owner 2026-10-20 (bloodsugarfriendly.com): a DTC page's label text is its Facts panel and the ingredient statement
 * after it, with div-built cells kept apart. Given the whole page (640 lines, the panel printed three times), the
 * label text model failed 46 of 46 runs on every model; given this, Luna medium read 7 of 10, all values right.
 * A page without a Facts panel keeps its whole text unless a single ingredient section has an explicit DOM boundary.
 */
export function extractDtcLabelCore(html: string): string {
  if (Buffer.byteLength(html) > MAX_BYTES) {
    throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
  }
  return boundedCore(labelPageText(html));
}

function extractDtcLabelCoreV1(html: string): string {
  if (Buffer.byteLength(html) > MAX_BYTES) {
    throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
  }
  return boundedCore(pageText(html, { rowCells: true }));
}

function boundedCore(text: string): string {
  const range = labelRange(text);
  const core = range ? text.slice(range.start, range.end) : text;
  if (core.length > MAX_TEXT_LENGTH) {
    throw labelCoreFailure("LABEL_CORE.OUTPUT_LIMIT");
  }
  return core;
}

/** Historical /1 reader is retained for verification of already published documents. */
export const dtcLabelCore: LabelCoreReader = {
  sourceModule: "channel.product-input",
  sourceVersion: "channel-plan/1",
  extract: extractDtcLabelCoreV1,
};

/** Current DTC reader for pages the shared product pipeline produced. */
export const dtcLabelCoreV2: LabelCoreReader = {
  sourceModule: "channel.product-input",
  sourceVersion: "channel-plan/1",
  extract: extractDtcLabelCore,
};
