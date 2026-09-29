import { parseDocument } from "htmlparser2";
import { labelCoreFailure, type LabelCoreReader } from "@crawl-automation/channels-core";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 200_000;
const FACTS_HEADING = /^(?:Supplement|Nutrition) Facts\s*\n/i;
const OTHER_INGREDIENTS = /^Other Ingredients[ \t]*:/gim;
const NEXT_SECTION =
  /^\s*(?:Suggested Use|Directions|Warning|Warnings|Storage Instructions|Other Information)\s*:/im;

type Nodes = ReturnType<typeof parseDocument>["children"];

/** The escaped `<pre>` sections of the page projection, as text; anything else on the page is not supported. */
function preSections(children: Nodes): string[] {
  const sections: string[] = [];
  for (const node of children) {
    if (node.type === "text" && !node.data.trim()) {
      continue;
    }
    const pre = node.type === "tag" && node.name === "pre" ? node : null;
    if (!pre || pre.children.some((child) => child.type !== "text")) {
      throw labelCoreFailure("LABEL_CORE.SOURCE_UNSUPPORTED");
    }
    const text = pre.children.map((child) => (child.type === "text" ? child.data : "")).join("");
    sections.push(text.replace(/\r\n?/g, "\n").trim());
  }
  return sections;
}

/** The one facts section, with its serving headings and exactly one other-ingredients heading. */
function factsSection(sections: string[]): { facts: string; heading: RegExpExecArray } {
  const candidates = sections.filter((section) => FACTS_HEADING.test(section));
  const [facts] = candidates;
  if (sections.length < 1 || sections.length > 2 || !facts || candidates.length !== 1) {
    throw labelCoreFailure("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  }
  const headings = [...facts.matchAll(OTHER_INGREDIENTS)];
  const [heading] = headings;
  if (
    !heading ||
    headings.length !== 1 ||
    !/^Serving Size\b/im.test(facts) ||
    !/^Amount Per Serving\b/im.test(facts)
  ) {
    throw labelCoreFailure("LABEL_CORE.TABLE_UNVERIFIED");
  }
  return { facts, heading: heading as RegExpExecArray };
}

/**
 * Swanson's label core: the Supplement/Nutrition Facts from the page projection that channel-plan/1 emits, up to the
 * end of its other ingredients. Not a general page cleaner: ingredient words, values and grouping are kept as printed.
 */
export function extractSwansonLabelCore(html: string): string {
  if (Buffer.byteLength(html) > MAX_BYTES) {
    throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
  }
  const { facts, heading } = factsSection(preSections(parseDocument(html).children));
  const after = heading.index + heading[0].length;
  const tail = facts.slice(after);
  const boundary = NEXT_SECTION.exec(tail);
  if (!boundary) {
    throw labelCoreFailure("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  }
  const ingredients = tail.slice(0, boundary.index).trim();
  if (
    !ingredients ||
    ingredients.includes("\n\n") ||
    /^(?:Supplement|Nutrition) Facts\b/im.test(ingredients)
  ) {
    throw labelCoreFailure("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  }
  const text = facts
    .slice(0, after + boundary.index)
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw labelCoreFailure("LABEL_CORE.OUTPUT_LIMIT");
  }
  return text;
}

/** Swanson's label-core reader, for pages the channel planner (channel-plan/1) produced. */
export const swansonLabelCore: LabelCoreReader = {
  sourceModule: "channel.product-input",
  sourceVersion: "channel-plan/1",
  extract: extractSwansonLabelCore,
};
