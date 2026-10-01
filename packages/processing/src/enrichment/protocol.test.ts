import { describe, expect, it } from "vitest";
import type { LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import { enrichmentContent, enrichmentHash, enrichmentInput } from "./protocol.js";
import { enrichmentModelRequest } from "./model-request.js";

const input = {
  protocol: "product-enrichment/2" as const,
  title: "Vitamin D 60 capsules 25 mcg",
  label: { servingSize: "1 capsule", ingredients: ["Rice flour"] },
};
describe("enrichment protocol", () => {
  it("keeps decoder warnings out of the model request schema", () => {
    const request = enrichmentModelRequest({ input, inputHash: "input", formulaHash: "formula" });
    expect(request.outputSchema.properties).not.toHaveProperty("warnings");
    expect(request.outputSchema.required).not.toContain("warnings");
  });
  it("canonicalizes object order and excludes field provenance from content", () => {
    expect(enrichmentContent({ name: { text: "Vitamin D", sourceId: "one" } })).toEqual(
      enrichmentContent({ name: { sourceId: "two", text: "Vitamin D" } }),
    );
    expect(enrichmentHash({ first: 1, second: 2 })).toBe(enrichmentHash({ second: 2, first: 1 }));
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
