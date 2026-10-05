import { pageText } from "@crawl-automation/channels-core";

const FACTS = /\b(?:supplement|nutrition(?:al)?|drug) facts\b/i;
const PANEL = [
  "product_details",
  "supplement_facts",
  "nutrition_facts",
  "nutritional_information",
  "drug_facts",
  "ingredients",
]
  .map((name) => `[data-testid="Accordion_${name}"]`)
  .join(",");
// Costco's own fields beside the label: allergen tags, marketing claims and its supplier disclaimer.
const BOILERPLATE =
  /^Text_(?:supplement|nutrition|drug)-facts-(?:contains|health-claims|disclaimer)(?:-title)?$/;
const INGREDIENTS = /(?:(?:Other|Inactive)\s+)?Ingredients\s*:/i;
const NEXT_SECTION =
  /(?:Warnings?|Cautions?|Directions|Suggested Use|Keep out of reach|These statements|Allergen|Contains\s*:|Storage|Store\b|Manufactured|Distributed)/i;

/** The structured facts panel without Costco's boilerplate fields. */
function labelPanel(panel: Element): string {
  const copy = panel.cloneNode(true) as Element;
  for (const field of [...copy.querySelectorAll("[data-testid]")]) {
    if (BOILERPLATE.test(field.getAttribute("data-testid") ?? "")) {
      field.remove();
    }
  }
  return copy.outerHTML;
}

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Pages without a facts panel print the ingredient list inline in the marketing paragraph
 * ("Suggested Use: ... Ingredients: A, B. Keep out of reach ..."): keep only that statement.
 */
function inlineIngredients(details: Element): string | null {
  const text = pageText(details.outerHTML);
  const heading = INGREDIENTS.exec(text);
  if (!heading) {
    return null;
  }
  const after = text.slice(heading.index + heading[0].length);
  const end = after.search(NEXT_SECTION);
  const list = (end < 0 ? after : after.slice(0, end)).split("\n")[0]?.trim();
  return list ? `<p>${escaped(`${heading[0]} ${list}`)}</p>` : null;
}

/**
 * Read actual product panels only; script translations and recommendation labels are never facts.
 * Label text excludes Costco's marketing and boilerplate, which would only become excluded text that
 * leaves a complete label's coverage uncertain (owner 2026-10-05).
 */
export function costcoContent(document: Document) {
  const details = document.querySelector('[data-testid="Accordion_product_details"]');
  const panels = [...document.querySelectorAll(PANEL)].filter((node) =>
    FACTS.test(pageText(node.outerHTML)),
  );
  const inline = !panels.length && details ? inlineIngredients(details) : null;
  const factsHtml = panels.length ? panels.map(labelPanel).join("\n") : inline;
  const detailsHtml = details && !panels.includes(details) ? details.outerHTML : null;
  return { detailsHtml, factsHtml };
}
