import { factsTextComplete, pageText, type FactsText } from "@crawl-automation/channels-core";
import { textOf, type AmazonDocument, type AmazonElement } from "./dom.js";

const FACTS_HEADING =
  /^(?:supplement facts|nutrition facts|ingredients?|other ingredients?)\s*:?[\s]*$/i;
const HEADINGS = "h2, h3, h4, h5, h6";
const SECTION_LABELS = `${HEADINGS}, span.a-text-bold`;

/**
 * Amazon's heading-delimited information blocks end at the next heading, not at an arbitrary byte
 * offset.
 */
function headingSection(heading: AmazonElement): string {
  const fragments = [heading.outerHTML];
  let sibling = heading.nextElementSibling;
  while (sibling && !sibling.matches(SECTION_LABELS)) {
    fragments.push(sibling.outerHTML);
    sibling = sibling.nextElementSibling;
  }
  return fragments.join("\n");
}

/**
 * Ingredient lists are retained even when incomplete; disclaimers, directions and marketing are not
 * facts.
 */
export function amazonFactsHtml(document: AmazonDocument): string | null {
  const blocks = [
    ...document.querySelectorAll(
      `#important-information ${HEADINGS.split(", ").join(", #important-information ")}, ` +
        "#important-information > .content > span.a-text-bold",
    ),
  ]
    .filter((heading) => FACTS_HEADING.test(textOf(heading)))
    .map(headingSection);
  const explicit = document.querySelectorAll(
    "#supplementFacts, #supplement-facts, #nutritionFacts, #nutrition-facts",
  );
  blocks.push(
    ...[...explicit]
      .filter((element) => !element.closest("#important-information"))
      .map((element) => element.outerHTML),
  );
  if (!blocks.length) {
    const rows = document.querySelectorAll("#productOverview_feature_div tr.po-ingredients");
    blocks.push(...[...rows].map((row) => row.outerHTML));
  }
  return [...new Set(blocks)].join("\n") || null;
}

function labelRequirements(text: string): string[] {
  const missing: string[] = [];
  if (!/\bSupplement Facts\b/i.test(text)) {
    missing.push("AMAZON.FACTS_LABEL_MISSING");
  }
  const start = Math.max(0, text.search(/\bSupplement Facts\b/i));
  const active = text.slice(start).split(/Other Ingredients\s*:?/i)[0] ?? "";
  const withoutServing = active.replace(/Serving Size[^\n]*/gi, "");
  const amount = /\b\d[\d,.]*\s*(?:mg|mcg|µg|μg|g|iu|cfu|billion|million|ml)\b/i;
  if (!amount.test(withoutServing)) {
    missing.push("FACTS.AMOUNTS_MISSING");
  }
  if (!/Serving Size\s*:?\s*(?:\n\s*)?\d/i.test(text)) {
    missing.push("FACTS.SERVING_SIZE_MISSING");
  }
  if (
    /(?:\.{3}|…)|Other Ingredients\s*:?\s*(?:see\b|refer\b|not (?:available|provided)|n\/a)/i.test(
      text,
    )
  ) {
    missing.push("AMAZON.FACTS_INCOMPLETE");
  }
  return missing;
}

/**
 * Text facts first requires a label, a filled serving size, an active amount and Other Ingredients.
 */
export function amazonFacts(html: string | null): FactsText {
  const text = html ? pageText(html) || null : null;
  const verdict = factsTextComplete(text);
  const missing = [...new Set([...verdict.reasons, ...(text ? labelRequirements(text) : [])])];
  return { text, complete: missing.length === 0, missing };
}
