import { expect, it } from "vitest";
import { EnrichmentCandidateSchema, EnrichmentModelOutputSchema } from "./enrichment.js";

const candidate = {
  unifiedName: "Vitamin D",
  baseName: "Vitamin D",
  form: "unknown",
  variant: { count: null, size: null, flavor: null, strength: null },
  healthFunctions: [],
  confidence: 1,
  notes: null,
};

it("reads existing candidates without adding warnings or changing their content", () => {
  expect(EnrichmentCandidateSchema.parse(candidate)).toEqual(candidate);
});

it("preserves optional decoder warnings through JSON storage", () => {
  const stored = { ...candidate, warnings: ["form-not-printed:liquid", "count-not-in-title"] };
  expect(EnrichmentCandidateSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
});

it("keeps warnings out of the model output contract", () => {
  const output = { ...candidate, functionalIngredients: [], inferredHealthFunctions: [] };
  expect(EnrichmentModelOutputSchema.parse(output)).toEqual(output);
  expect(
    EnrichmentModelOutputSchema.safeParse({ ...output, warnings: ["form-not-printed:liquid"] })
      .success,
  ).toBe(false);
});

it("asks the model for each health function as a name with its printed words (product-enrichment/4)", () => {
  const output = { ...candidate, functionalIngredients: [], inferredHealthFunctions: [] };
  const claim = { name: "Bone Health", printed: "Supports bones" };
  expect(EnrichmentModelOutputSchema.parse({ ...output, healthFunctions: [claim] })).toMatchObject({
    healthFunctions: [claim],
  });
  expect(
    EnrichmentModelOutputSchema.safeParse({ ...output, healthFunctions: ["Supports bones"] }).success,
  ).toBe(false);
  // Stored /3 candidates keep plain names and no evidence.
  expect(EnrichmentCandidateSchema.parse({ ...candidate, healthFunctions: ["Supports bones"] }))
    .toMatchObject({ healthFunctions: ["Supports bones"] });
});
