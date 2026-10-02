import { expect, it } from "vitest";
import { applyDetailExtractionProfile, extractDetailDomRecord } from "./engine.mjs";

const url = "https://shop.test/products/zinc";
const accordion = (heading, body) => `<div class="product__accordion accordion"><details><summary><div class="summary__title"><h2 class="accordion__title">${heading}</h2></div></summary><div class="accordion__content"><p><span>${body}</span></p></div></details></div>`;
const html = `<main><h1>Zinc Copper</h1>${accordion("Ingredients", "Zinc, copper, cellulose.")}${accordion("Directions", "Take one capsule daily.")}${accordion("Warnings", "Keep away from children.")}${accordion("Can I take this supplement with medications?", "Ask your clinician.")}</main>`;

it("keeps adjacent nested accordion headings paired with their own bodies", () => {
  const { fields } = extractDetailDomRecord(url, html);
  expect(fields.ingredients).toBe("Zinc, copper, cellulose.");
  expect(fields.recommended_daily_intake).toBe("Take one capsule daily.");
  expect(fields.notes).toBe("Keep away from children.");
  expect(fields.supplement_facts).toBeUndefined();
  expect(fields.supplementFacts).toBeUndefined();
});

it("does not treat Directions or a supplement FAQ as Facts through profile fallback", () => {
  const normal = applyDetailExtractionProfile({
    profile: { version: 1, fieldRules: {}, factLabels: ["Supplement Facts"] },
    evidence: { url, html, requestedFields: ["title", "supplement_facts"] },
  });
  expect(normal.record.fields.supplement_facts).toBeUndefined();
});

it("preserves real textual Facts and excludes the following Directions section", () => {
  const page = `<main><h1>Zinc</h1><h2>Supplement Facts</h2><p>Serving Size 1 capsule</p><p>Zinc 50 mg</p><h2>Directions</h2><p>Take one daily.</p></main>`;
  const { fields } = extractDetailDomRecord(url, page);
  expect(fields.supplement_facts).toContain("Zinc 50 mg");
  expect(fields.supplement_facts).not.toContain("Take one");
  expect(fields.recommended_daily_intake).toBe("Take one daily.");
});

it("keeps image-only Facts empty without importing neighboring FAQ text", () => {
  const page = `<main><h1>Zinc</h1>${accordion("Supplement Facts", '<img src="facts.png">')}${accordion("Directions", "Take one.")}${accordion("Can I take supplements?", "Read the warnings.")}</main>`;
  const { record } = applyDetailExtractionProfile({
    profile: { version: 1, fieldRules: {}, factLabels: ["Supplement Facts"] },
    evidence: { url, html: page, requestedFields: ["title", "supplement_facts"] },
  });
  expect(record.fields.supplement_facts).toBeUndefined();
});

it("uses exact ARIA controls instead of the neighboring panel", () => {
  const page = '<h1>Zinc</h1><button aria-controls="use">Directions</button><button aria-controls="ingredients">Ingredients</button><div id="ingredients">Cellulose.</div><div id="use">One daily.</div>';
  const { fields } = extractDetailDomRecord(url, page);
  expect(fields.ingredients).toBe("Cellulose.");
  expect(fields.recommended_daily_intake).toBe("One daily.");
});

it("preserves explicit field mappings and real facts tables", () => {
  const page = '<h1>Zinc</h1><p id="dose">One capsule.</p><table><tr><th>Nutrient</th><th>Amount</th></tr><tr><td>Zinc</td><td>50 mg</td></tr></table>';
  const { record } = applyDetailExtractionProfile({
    profile: { version: 1, fieldRules: { recommended_daily_intake: [{ mode: "selector_text", selectors: ["#dose"] }] } },
    evidence: { url, html: page, requestedFields: ["title", "recommended_daily_intake", "supplement_facts"] },
  });
  expect(record.fields.recommended_daily_intake).toBe("One capsule.");
  expect(record.fields.supplement_facts).toContain("Zinc | 50 mg");
});
