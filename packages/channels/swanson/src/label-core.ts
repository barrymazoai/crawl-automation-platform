import { parseDocument } from "htmlparser2";
import {
  extractDrugFactsCore,
  ingredientHeadingIndexes,
  labelFactsHeadings,
  labelCoreFailure,
  type LabelCoreReader,
} from "@crawl-automation/channels-core";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 200_000;
const FACTS_HEADING = /^(?:Supplement|Nutrition) Facts\s*\n/i;
const INGREDIENTS = /^(?:Other Ingredients|Ingredients)[ \t]*(?::|$)/gim;
// Allergen and trademark notes follow Other Ingredients on many Swanson pages (2026-09-30: 8 Healthy Origins
// products); they end the ingredient list like the sections after them.
// Owner 2026-10-09: food labels print these headings alone on their line, without a colon ("Allergen Information");
// "Certifier:", "Typical Amino Acids Profile:" and "Sku:" also follow the list on saved Swanson pages.
const COLON_SECTION =
  /^[ \t]*(?:Allergen Information|Trademark Information|Certifier(?: Information)?|Typical Amino Acids? Profile|Sku|Additional Product Information|Country of Origin|Suggested Use|Directions|Warning|Warnings|Storage Instructions|Other Information)[ \t]*:/im;
// Without a colon only multi-word headings count: a bare "Directions" or "Warning" line could be part of a list.
const BARE_SECTION =
  /^[ \t]*(?:Allergen Information|Trademark Information|Certifier Information|Typical Amino Acids? Profile|Additional Product Information|Country of Origin|Suggested Use|Storage Instructions|Other Information)[ \t]*$/im;
const NEXT_SECTION = {
  exec(text: string): { index: number } | null {
    const found = [COLON_SECTION.exec(text), BARE_SECTION.exec(text)].filter(
      (match): match is RegExpExecArray => match !== null,
    );
    return found.length ? { index: Math.min(...found.map((match) => match.index)) } : null;
  },
};

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

/**
 * The one facts section, with its serving headings and at most one other-ingredients heading. Owner 2026-10-09
 * (CRAWLV3-214): a facts table without an ingredient list (teas, honey) is a formula-only label, not a refusal.
 */
function factsSection(sections: string[]): { facts: string; heading: RegExpExecArray | null } {
  const candidates = sections.filter((section) => FACTS_HEADING.test(section));
  const [facts] = candidates;
  if (sections.length < 1 || sections.length > 2 || !facts || candidates.length !== 1) {
    throw labelCoreFailure("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  }
  if (!/^Serving Size\b/im.test(facts) || !/^Amount Per Serving\b/im.test(facts)) {
    throw labelCoreFailure("LABEL_CORE.TABLE_UNVERIFIED");
  }
  return { facts, heading: ingredientsHeading(facts) };
}

/** The facts section's one other-ingredients heading; null when it prints none, refused when it prints several. */
function ingredientsHeading(facts: string): RegExpExecArray | null {
  const all = [...facts.matchAll(INGREDIENTS)];
  const headings = ingredientHeadingIndexes(all.map((match) => match[0]));
  const heading = all[headings[0] ?? -1];
  if (headings.length > 1 || (headings.length === 1 && !heading)) {
    throw labelCoreFailure("LABEL_CORE.TABLE_UNVERIFIED");
  }
  return (heading as RegExpExecArray | undefined) ?? null;
}

/**
 * Swanson's label core: the Supplement/Nutrition/Drug Facts from the page projection that channel-plan/1 emits, up to the
 * end of its other ingredients. Not a general page cleaner: ingredient words, values and grouping are kept as printed.
 */
export function extractSwansonLabelCore(html: string): string {
  if (Buffer.byteLength(html) > MAX_BYTES) {
    throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
  }
  const sections = preSections(parseDocument(html).children);
  const headings = sections.flatMap(labelFactsHeadings);
  const [only] = sections;
  if (headings.length === 0 && sections.length === 1 && only) {
    return normalizeCore(ingredientsOnlyCore(only));
  }
  if (headings.length !== 1 || sections.length > 2) {
    throw labelCoreFailure("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  }
  const drug = sections.find((section) => /^Drug Facts[ \t]*:?[ \t]*$/im.test(section));
  return normalizeCore(drug ? extractDrugFactsCore(drug) : supplementCore(sections));
}

function supplementCore(sections: string[]): string {
  const { facts, heading } = factsSection(sections);
  if (!heading) {
    const boundary = NEXT_SECTION.exec(facts);
    return boundary ? facts.slice(0, boundary.index) : facts;
  }
  const after = heading.index + heading[0].length;
  const tail = facts.slice(after);
  // The list may also end the facts section (owner 2026-10-09); a blank line inside it is still refused below.
  const end = NEXT_SECTION.exec(tail)?.index ?? tail.length;
  const ingredients = tail.slice(0, end).trim();
  if (
    !ingredients ||
    ingredients.includes("\n\n") ||
    /^(?:Supplement|Nutrition) Facts\b/im.test(ingredients)
  ) {
    throw labelCoreFailure("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  }
  return facts.slice(0, after + end);
}

/**
 * Owner 2026-10-06 (CRAWLV3-209): a product with ingredients and no Facts panel is still a label product. Swanson
 * prints these (creams, oils, bulk herbs) as one Product Facts section holding a single Ingredients list.
 */
function ingredientsOnlyCore(section: string): string {
  const all = [...section.matchAll(INGREDIENTS)];
  const headings = ingredientHeadingIndexes(all.map((match) => match[0]));
  const heading = all[headings[0] ?? -1];
  if (!heading || headings.length !== 1) {
    throw labelCoreFailure("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  }
  const list = section.slice(heading.index);
  const boundary = NEXT_SECTION.exec(list.slice(heading[0].length));
  const core = list.slice(0, boundary ? heading[0].length + boundary.index : list.length).trim();
  if (core.length <= heading[0].trim().length) {
    throw labelCoreFailure("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  }
  return core;
}

function normalizeCore(raw: string): string {
  const text = raw
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
