import {
  allowedContent,
  labelCoreFailure,
  labelRange,
  pageText,
  type LabelRangeOptions,
  type LabelCoreReader,
} from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { INGREDIENT_HEADING, ingredientChromePanels } from "./label-ingredient-panels.js";

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

/** What the chrome pruning keeps whole: label panels, and (/5) chrome sections that hold a Facts heading. */
interface Pruning {
  ingredientPanels: ReadonlySet<Element>;
  factsSections: boolean;
}

const HEADING_ELEMENTS = "h1, h2, h3, h4, h5, h6, summary, caption, [role='heading']";

/**
 * /5: EarthNutri (2026-10-26) prints its Facts heading, serving lines and Other Ingredients in one column and the rows
 * in a div-built chart beside it, all inside an accordion-classed section. Read cell by cell, a name cell
 * ("AminoBlast") has no label word, so every row was pruned and the model got a Facts heading without rows.
 */
function holdsFactsHeading(node: Element): boolean {
  return [...node.querySelectorAll(HEADING_ELEMENTS)].some((heading) =>
    /^(?:supplement|nutrition)\s+facts\b/i.test(heading.textContent?.trim() ?? ""),
  );
}

function labelParagraph(node: Element): boolean {
  const paragraph = node.matches("p, li, tr, td, th");
  const leafBlock =
    node.matches("div") && !node.querySelector("p, div, li, section, details, table");
  return (paragraph || leafBlock) && labelMatter(node.textContent ?? "");
}

function wholePanel(node: Element, pruning: Pruning): boolean {
  return factsPanel(node) || pruning.ingredientPanels.has(node);
}

function keptChrome(node: Element, pruning: Pruning): boolean {
  return labelParagraph(node) || (pruning.factsSections && holdsFactsHeading(node));
}

/** Remove a whole chrome subtree only when it contains no label paragraph; otherwise prune its unrelated children. */
function pruneChrome(node: Element, pruning: Pruning, inChrome = false): void {
  if (wholePanel(node, pruning)) {
    return;
  }
  const chrome = inChrome || chromeContainer(node);
  if (chrome && keptChrome(node, pruning)) {
    return;
  }
  if (chrome && !labelMatter(node.textContent ?? "")) {
    node.remove();
    return;
  }
  for (const child of [...node.childNodes]) {
    pruneChromeChild(child, chrome, pruning);
  }
}

function pruneChromeChild(child: ChildNode, chrome: boolean, pruning: Pruning): void {
  if (child.nodeType === 1) {
    pruneChrome(child as Element, pruning, chrome);
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
function ingredientPanel(root: Element, preservedPanels: ReadonlySet<Element>): Element | null {
  const panels = [...root.querySelectorAll("h2, h3, h4, summary")]
    .map(ingredientHeadingPanel)
    .filter((panel): panel is Element => panel !== null && !preservedPanels.has(panel));
  return panels.length === 1 ? (panels[0] ?? null) : null;
}

function ingredientHeadingPanel(heading: Element): Element | null {
  if (!INGREDIENT_HEADING.test(heading.textContent?.trim() ?? "")) {
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

type PanelPolicy = "none" | "legacy" | "scoped";

/** How one reader version reads a page: which ingredient panels and (/5) Facts sections it keeps whole. */
interface CoreVersion {
  panels: PanelPolicy;
  /** /5: Facts sections kept whole, and their div-built rows read with marker cells (label-range.ts). */
  factsCharts: boolean;
}

function labelPageText(html: string, version: CoreVersion): string {
  // The channel plan supplies an HTML fragment; wrapping it gives linkedom a stable body for DOM pruning.
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const ingredientPanels =
    version.panels !== "none"
      ? ingredientChromePanels(document.body, version.panels === "scoped")
      : new Set<Element>();
  const pruning = { ingredientPanels, factsSections: version.factsCharts };
  for (const child of [...document.body.children]) {
    pruneChrome(child, pruning);
  }
  const full = withoutChromeLines(pageText(document.body.innerHTML, { rowCells: true }));
  if (labelRange(full, { markerCells: version.factsCharts })) {
    return full;
  }
  const panel = ingredientPanel(document.body, ingredientPanels);
  return panel ? withoutChromeLines(pageText(panel.innerHTML, { rowCells: true })) : full;
}

/**
 * Owner 2026-10-20 (bloodsugarfriendly.com): a DTC page's label text is its Facts panel and the ingredient statement
 * after it, with div-built cells kept apart. Given the whole page (640 lines, the panel printed three times), the
 * label text model failed 46 of 46 runs on every model; given this, Luna medium read 7 of 10, all values right.
 * A page without a Facts panel keeps its whole text unless a single ingredient section has an explicit DOM boundary.
 */
export function extractDtcLabelCore(html: string): string {
  return extractDtcLabelCoreWithPanels(html, { panels: "scoped", factsCharts: true });
}

function extractDtcLabelCoreV2(html: string): string {
  return extractDtcLabelCoreWithPanels(html, { panels: "none", factsCharts: false });
}

function extractDtcLabelCoreV3(html: string): string {
  return extractDtcLabelCoreWithPanels(html, { panels: "legacy", factsCharts: false });
}

function extractDtcLabelCoreV4(html: string): string {
  return extractDtcLabelCoreWithPanels(html, { panels: "scoped", factsCharts: false });
}

function extractDtcLabelCoreWithPanels(html: string, version: CoreVersion): string {
  if (Buffer.byteLength(html) > MAX_BYTES) {
    throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
  }
  return boundedCore(labelPageText(html, version), { markerCells: version.factsCharts });
}

function extractDtcLabelCoreV1(html: string): string {
  if (Buffer.byteLength(html) > MAX_BYTES) {
    throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
  }
  return boundedCore(pageText(html, { rowCells: true }), {});
}

function boundedCore(text: string, options: LabelRangeOptions): string {
  const range = labelRange(text, options);
  const core = range ? text.slice(range.start, range.end) : text;
  if (core.length > MAX_TEXT_LENGTH) {
    throw labelCoreFailure("LABEL_CORE.OUTPUT_LIMIT");
  }
  return core;
}

const reader = (extract: (html: string) => string): LabelCoreReader => ({
  sourceModule: "channel.product-input",
  sourceVersion: "channel-plan/1",
  extract,
});

/** Historical /1–/4 readers are retained for verification of already published documents. */
export const dtcLabelCore = reader(extractDtcLabelCoreV1);
export const dtcLabelCoreV2 = reader(extractDtcLabelCoreV2);
export const dtcLabelCoreV3 = reader(extractDtcLabelCoreV3);
export const dtcLabelCoreV4 = reader(extractDtcLabelCoreV4);

/** Current DTC reader for pages the shared product pipeline produced. */
export const dtcLabelCoreV5 = reader(extractDtcLabelCore);
