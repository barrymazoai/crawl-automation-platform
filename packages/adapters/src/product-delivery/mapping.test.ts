import { describe, expect, it } from "vitest";
import { mapDeliveryProduct } from "@crawl-automation/app";
import { deliveryProduct, deliveryRequest } from "./product.fixture.js";
import { deliveryEnrichmentFixture } from "./enrichment.fixture.js";

describe("settled DTC observation mapping", () => {
  it("maps only grounded enrichment and never treats unit count as servings or inferred functions as observations", () => {
    const source = deliveryProduct();
    if (!source.collection) {
      throw new Error("fixture");
    }
    source.enrichment = deliveryEnrichmentFixture(source.collection);
    const { item } = mapDeliveryProduct(source, deliveryRequest);
    expect(item).toMatchObject({
      baseName: "FocusFuel",
      productForm: "gummy",
      variant: { form: "gummy", size: "30 count" },
      variantConfidence: 87,
      variantSource: "ai_extract",
      mainIngredients: ["L-Theanine"],
      healthFunctions: ["Focus"],
    });
    expect(item.variant).not.toHaveProperty("pack");
    expect(item.variant).not.toHaveProperty("servings");
    expect(item.healthFunctions).not.toContain("Sleep");
  });

  it("keeps a valid ingredients-only result without inventing Facts or label confidence", () => {
    const source = deliveryProduct();
    if (!source.collection) {
      throw new Error("fixture");
    }
    source.collection = {
      ...source.collection,
      schemaVersion: 5,
      codec: "collected-product/5",
      evidencePolicy: "label-image-first/7",
      formula: null,
      labelType: "none",
      formulaFound: false,
      ingredientsFound: true,
      pageEvidence: [],
    };
    const content = mapDeliveryProduct(source, deliveryRequest).label.label.content;
    expect(content.formula).toBeNull();
    expect(content.formulaComplete).toBe(false);
    expect(content.otherIngredients).toEqual(source.collection.otherIngredients);
  });

  it("does not flatten Drug Facts fields into the older supplement-label contract", () => {
    const source = deliveryProduct();
    if (source.collection?.formula) {
      source.collection.formula.drugFacts = source.collection.formula.servingSize;
    }
    expect(() => mapDeliveryProduct(source, deliveryRequest)).toThrow(/losslessly/u);
  });

  it("refuses foreign-site observations even when their SKU ID matches", () => {
    expect(() =>
      mapDeliveryProduct(deliveryProduct(), { ...deliveryRequest, siteKey: "other.example" }),
    ).toThrow(/hash or SKU owner/u);
  });
  it("keeps the product's brand, stable SKU, observed timestamp, unavailable stock and raw full label", () => {
    const source = deliveryProduct();
    const mapped = mapDeliveryProduct(source, deliveryRequest);
    expect(mapped.item).toMatchObject({
      externalId: "variant-1",
      brandName: "FocusFuel",
      inStock: false,
      capturedAt: "2026-10-09T02:00:00.000Z",
      price: "24.00",
      currency: "USD",
    });
    expect(mapped.item.images.map((image) => image.url)).toEqual(["https://example.com/facts.jpg"]);
    expect(mapped.label.label.content.formula).toEqual(source.collection?.formula);
    expect(mapped.label.label.content.otherIngredients).toEqual(
      source.collection?.otherIngredients,
    );
    expect(mapped.label.label.evidence.assembly).toEqual(source.collection?.assembly);
    expect(mapped.item).not.toHaveProperty("facts");
    expect(mapped.item).not.toHaveProperty("variantKey");
    expect(mapped.label).not.toHaveProperty("runId");
    expect(mapped.label.label).not.toHaveProperty("confidence");
  });

  it("does not infer defaults from absent metadata or the site domain", () => {
    const source = deliveryProduct();
    if (!source.history || !source.product) {
      throw new Error("fixture");
    }
    source.history.metrics = {};
    source.product.brandRaw = deliveryRequest.siteKey;
    const { item } = mapDeliveryProduct(source, deliveryRequest);
    for (const key of [
      "price",
      "currency",
      "inStock",
      "brandName",
      "baseName",
      "variant",
      "gtin",
    ]) {
      expect(item).not.toHaveProperty(key);
    }
  });

  it("gives each variant an independent anchor without copying sibling labels", () => {
    const first = mapDeliveryProduct(deliveryProduct("1"), deliveryRequest);
    const second = mapDeliveryProduct(deliveryProduct("2"), deliveryRequest);
    expect(first.item.clientRef).not.toBe(second.item.clientRef);
    expect(first.label.submitter.operationId).not.toBe(second.label.submitter.operationId);
    expect(second.label.observation.variantId).toBe("variant-2");
  });

  it("rejects another variant's retained projection", () => {
    const source = deliveryProduct();
    if (source.product) {
      source.product.variantId = "foreign";
    }
    expect(() => mapDeliveryProduct(source, deliveryRequest)).toThrow(/hash or SKU owner/u);
  });
});
