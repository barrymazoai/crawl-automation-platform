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

/** Read actual product panels only; script translations and recommendation labels are never facts. */
export function costcoContent(document: Document) {
  const details = document.querySelector('[data-testid="Accordion_product_details"]');
  const panels = [...document.querySelectorAll(PANEL)].filter((node) =>
    FACTS.test(pageText(node.outerHTML)),
  );
  const factsHtml = panels.length ? panels.map((node) => node.outerHTML).join("\n") : null;
  const detailsHtml = details && !panels.includes(details) ? details.outerHTML : null;
  return { detailsHtml, factsHtml };
}
