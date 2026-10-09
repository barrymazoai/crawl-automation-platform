import { parseDocument } from "htmlparser2";
import {
  extractDrugFactsCore,
  ingredientHeadingIndexes,
  labelFactsHeadings,
  labelCoreFailure,
  type LabelCoreReader,
} from "@crawl-automation/channels-core";

/** The parts of an htmlparser2 node this reader looks at. */
interface PageNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  data?: string;
  children?: PageNode[];
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 50_000;
const MAX_DEPTH = 100;
const MAX_TEXT_LENGTH = 200_000;
const omitted = new Set(["script", "style", "template", "noscript"]);
const blocks = new Set(["table", "tr", "td", "th", "p", "div", "br", "h4", "li"]);

const normalize = (text: string) =>
  text
    .replace(/[\t\r \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const hasClass = (node: PageNode, name: string) =>
  node.attribs?.["class"]?.split(/\s+/).includes(name) ?? false;

/** Every node (outside scripts and styles) the predicate accepts, in document order. */
function find(nodes: PageNode[], predicate: (node: PageNode) => boolean): PageNode[] {
  return nodes.flatMap((node) =>
    omitted.has(node.name ?? "")
      ? []
      : [...(predicate(node) ? [node] : []), ...find(node.children ?? [], predicate)],
  );
}

function textOf(node: PageNode): string {
  if (omitted.has(node.name ?? "")) {
    return "";
  }
  if (node.type === "text") {
    return node.data ?? "";
  }
  const body = (node.children ?? []).map(textOf).join("");
  return blocks.has(node.name ?? "") ? `\n${body}\n` : body;
}

/** Bounds the whole tree before any recursive reading, including adversarial nesting. */
function assertBounded(root: PageNode): void {
  const pending = [{ node: root, depth: 0 }];
  let count = 0;
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (++count > MAX_NODES || next.depth > MAX_DEPTH) {
      throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
    }
    const depth = next.depth + 1;
    pending.push(...(next.node.children ?? []).map((node) => ({ node, depth })));
  }
}

/** The one outer facts table of the label (nested layout tables stay part of it), with its serving headings. */
function factsTable(label: PageNode): string {
  const outer: PageNode[] = [];
  const collect = (node: PageNode) =>
    node.name === "table" ? outer.push(node) : (node.children ?? []).forEach(collect);
  collect(label);
  const [table] = outer;
  if (!table || outer.length !== 1) {
    throw labelCoreFailure("LABEL_CORE.TABLE_SCOPE_AMBIGUOUS");
  }
  const facts = normalize(textOf(table));
  // GNC tables may head the amount column "Per Serving" alone (2026-09-30, Bucked Up 500953).
  if (!/serving\s+size/i.test(facts) || !/(?:amounts?\s+)?per\s+serving/i.test(facts)) {
    throw labelCoreFailure("LABEL_CORE.TABLE_UNVERIFIED");
  }
  return facts;
}

/**
 * The one accordion section headed "Other ingredients", with its content; null when the label has none. Owner
 * 2026-10-09 (CRAWLV3-214): a facts table without an ingredient list is a formula-only label, not a refusal.
 */
function otherIngredients(label: PageNode): string | null {
  const sections = find(label.children ?? [], (node) =>
    hasClass(node, "pdp-details-accordion__section"),
  );
  const headings = sections.flatMap((section) =>
    find(section.children ?? [], (node) => node.name === "h4").map((heading) => ({
      section,
      text: normalize(textOf(heading)),
    })),
  );
  const headed = ingredientHeadingIndexes(headings.map((heading) => heading.text)).map(
    (index) => headings[index]?.section,
  );
  const [section] = headed;
  if (headed.length === 0) {
    return null;
  }
  const content = section
    ? find(section.children ?? [], (node) =>
        hasClass(node, "pdp-details-accordion__section-content"),
      )
    : [];
  const [body] = content;
  if (
    !section ||
    headed.length !== 1 ||
    !body ||
    content.length !== 1 ||
    !normalize(textOf(body))
  ) {
    throw labelCoreFailure("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  }
  return normalize(textOf(section));
}

/**
 * GNC's label core: the product's nutrition-description facts table plus its "Other ingredients" section. Scoped to
 * the SKU fragment; not a general page cleaner. Ingredient words, doses, group names and footers are kept as printed.
 */
export function extractGncLabelCore(html: string): string {
  if (Buffer.byteLength(html) > MAX_BYTES) {
    throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
  }
  const document = parseDocument(html) as unknown as PageNode;
  assertBounded(document);
  const labels = find(document.children ?? [], (node) =>
    hasClass(node, "product-nutrition-description"),
  );
  const [label] = labels;
  if (!label || labels.length !== 1) {
    throw labelCoreFailure("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  }
  const text = normalize(textOf(label));
  const headings = labelFactsHeadings(text);
  if (headings.length > 1) {
    throw labelCoreFailure("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  }
  const result = /^Drug Facts[ \t]*:?[ \t]*$/im.test(text)
    ? extractDrugFactsCore(text)
    : [factsTable(label), otherIngredients(label)].filter((part) => part !== null).join("\n\n");
  if (result.length > MAX_TEXT_LENGTH) {
    throw labelCoreFailure("LABEL_CORE.OUTPUT_LIMIT");
  }
  return result;
}

/** GNC's label-core reader, for pages GNC capture produced. */
export const gncLabelCore: LabelCoreReader = {
  sourceModule: "gnc.product-input",
  extract: extractGncLabelCore,
};
