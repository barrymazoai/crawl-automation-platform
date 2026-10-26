import { expect, it } from "vitest";
import type { EnrichmentCandidate } from "@crawl-automation/v3-contracts";
import { decodeEnrichment } from "./decode.js";
import type { EnrichmentContent } from "./protocol.js";

const candidate: EnrichmentCandidate = {
  unifiedName: "Vitamin D 25 mcg",
  baseName: "Vitamin D",
  form: "unknown",
  variant: { count: null, size: null, flavor: null, strength: "25 mcg" },
  healthFunctions: [],
  functionalIngredients: [],
  inferredHealthFunctions: [],
  confidence: 0.95,
  notes: null,
};
const input = (title: string): EnrichmentContent["input"] => ({
  protocol: "product-enrichment/4",
  title: `Vitamin D 25 mcg | ${title}`,
  label: {},
});
const decode = (form: EnrichmentCandidate["form"], title: string) =>
  decodeEnrichment(JSON.stringify({ ...candidate, form }), input(title));

// Real titles the owner's 2026-10-26 audit found without a form (GNC, Costco).
it.each([
  ["tablet", "TriFlex Joint Support Fast-Acting - 120 Caplets (30 Servings)"],
  ["tablet", "Kirkland Signature Daily Multi, 500 Tabs"],
  ["capsule", "SOLARAY Mycrobiome Complete Probiotic, 30 VegCaps"],
  ["capsule", "Nature's Way Black Cohosh, 2 Liqui-Caps"],
  ["softgel", "Carlson Vitamin A 10,000 IU 250 Sgels"],
  ["chewable", "Force Factor Total Beets, 90 Soft Chews, Berry Flavor"],
  ["gummy", "Kids Vitamin B12 650mcg - 60 Jelly Beans (60 Servings)"],
  ["powder", "Zipfizz Multi-Vitamin Energy Hydration Drink Mix, 30 Tubes"],
  ["liquid", "5-hour Energy Shot, Extra Strength, Berry, 1.93 fl.oz, 24-count"],
])("accepts a common printed name for %s: %s", (form, title) => {
  const result = decode(form as EnrichmentCandidate["form"], title);
  expect(result.form).toBe(form);
  expect(result.warnings ?? []).not.toContain(`form-not-printed:${form}`);
});
it.each([
  ["powder", "Trail Mix"],
  ["liquid", "Shotgun Formula"],
  ["capsule", "Capsaicin Cream"],
])("a form name only counts as a whole word or phrase: %s in %s", (form, title) => {
  const result = decode(form as EnrichmentCandidate["form"], title);
  expect(result.form).toBe("unknown");
});
