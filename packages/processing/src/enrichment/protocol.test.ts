import { describe, expect, it } from "vitest";
import type { LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import { decodeEnrichment } from "./decode.js";
import { enrichmentContent, enrichmentHash, enrichmentInput } from "./protocol.js";

const input = {
  protocol: "product-enrichment/2" as const,
  title: "Vitamin D 60 capsules 25 mcg",
  label: { servingSize: "1 capsule", ingredients: ["Rice flour"] },
};
const candidate = {
  unifiedName: "Vitamin D 25 mcg",
  baseName: "Vitamin D",
  form: "capsule",
  variant: { count: 60, size: null, flavor: null, strength: "25 mcg" },
  healthFunctions: [],
  confidence: 0.95,
  notes: null,
};

describe("enrichment protocol", () => {
  it("decodes grounded attributes and preserves null quantities", () => {
    expect(decodeEnrichment(JSON.stringify(candidate), input)).toEqual(candidate);
  });
  it.each([
    "not-json",
    JSON.stringify({ ...candidate, confidence: 2 }),
    JSON.stringify({ ...candidate, healthFunctions: ["Cures cancer"] }),
    JSON.stringify({ ...candidate, variant: { ...candidate.variant, count: 1 } }),
    JSON.stringify({ ...candidate, form: "liquid" }),
  ])("rejects unsupported output %s", (answer) => {
    expect(() => decodeEnrichment(answer, input)).toThrow(
      expect.objectContaining({ code: "ENRICH.OUTPUT_INVALID" }),
    );
  });
  it("canonicalizes object order and excludes field provenance from content", () => {
    expect(enrichmentContent({ name: { text: "Vitamin D", sourceId: "one" } })).toEqual(
      enrichmentContent({ name: { sourceId: "two", text: "Vitamin D" } }),
    );
    expect(enrichmentHash({ first: 1, second: 2 })).toBe(enrichmentHash({ second: 2, first: 1 }));
  });
  it("keeps conflicting printed counts unknown", () => {
    const ambiguous = { ...input, title: "Vitamin D 60 capsules / 120 capsules 25 mcg" };
    expect(() => decodeEnrichment(JSON.stringify(candidate), ambiguous)).toThrow();
    const unknown = { ...candidate, variant: { ...candidate.variant, count: null } };
    expect(decodeEnrichment(JSON.stringify(unknown), ambiguous).variant.count).toBeNull();
  });
  it("does not assemble a new health claim from unrelated printed words", () => {
    const combined = { ...input, label: ["no artificial color", "sugar"] };
    expect(() =>
      decodeEnrichment(JSON.stringify({ ...candidate, healthFunctions: ["no sugar"] }), combined),
    ).toThrow();
  });
  it("reuses identical title/formula input across observations but separates changed variants", () => {
    const formula = {
      formula: { name: { text: "Vitamin D", sourceId: "one" } },
      otherIngredients: null,
      ingredients: [],
    } as unknown as LabelCollectedProduct;
    const first = enrichmentInput(formula, input.title);
    const other = structuredClone(formula);
    Object.assign(other, { operationId: "another", observation: { listingId: "other" } });
    expect(enrichmentInput(other, input.title).inputHash).toBe(first.inputHash);
    expect(enrichmentInput(other, "Vitamin D 120 capsules").inputHash).not.toBe(first.inputHash);
  });
});
