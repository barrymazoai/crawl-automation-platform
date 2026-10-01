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

it("keeps warnings out of the unchanged model output contract", () => {
  expect(EnrichmentModelOutputSchema.parse(candidate)).toEqual(candidate);
  expect(
    EnrichmentModelOutputSchema.safeParse({ ...candidate, warnings: ["form-not-printed:liquid"] })
      .success,
  ).toBe(false);
});
