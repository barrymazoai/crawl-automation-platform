import { describe, expect, it } from "vitest";
import type {
  EnrichmentWebsiteVariant,
  LabelCollectedProduct,
} from "@crawl-automation/v3-contracts";
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
    const first = enrichmentInput(formula, { title: input.title });
    const other = structuredClone(formula);
    Object.assign(other, { operationId: "another", observation: { listingId: "other" } });
    expect(enrichmentInput(other, { title: input.title }).inputHash).toBe(first.inputHash);
    expect(enrichmentInput(other, { title: "Vitamin D 120 capsules" }).inputHash).not.toBe(
      first.inputHash,
    );
  });
  it("separates website variant content from old inputs without hashing evidence locations", () => {
    const collection = {
      formula: {},
      ingredients: [],
      otherIngredients: null,
    } as unknown as LabelCollectedProduct;
    const variant: EnrichmentWebsiteVariant = {
      protocol: "website-variant/1",
      variantId: "one",
      title: "100 ct",
      options: ["VegCaps: 100 ct"],
      evidence: { sourceId: "first", sha256: "a".repeat(64) },
    };
    const old = enrichmentInput(collection, { title: "Zinc Copper" });
    const current = enrichmentInput(collection, { title: "Zinc Copper", websiteVariant: variant });
    expect(current.inputHash).not.toBe(old.inputHash);
    expect(current.formulaHash).toBe(old.formulaHash);
    expect(
      enrichmentInput(collection, {
        title: "Zinc Copper",
        websiteVariant: {
          ...variant,
          variantId: "other",
          evidence: { sourceId: "second", sha256: "b".repeat(64) },
        },
      }).inputHash,
    ).toBe(current.inputHash);
    expect(
      enrichmentInput(collection, {
        title: "Zinc Copper",
        websiteVariant: { ...variant, title: "200 ct", options: [] },
      }).inputHash,
    ).not.toBe(current.inputHash);
    expect(old.input).toEqual({
      protocol: "product-enrichment/3",
      title: "Zinc Copper",
      label: { formula: {}, ingredients: [], otherIngredients: null },
    });
  });
});
