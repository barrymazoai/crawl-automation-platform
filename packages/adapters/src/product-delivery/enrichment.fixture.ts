import type { LabelCollectedProduct, SharedEnrichmentRecord } from "@crawl-automation/v3-contracts";

export function deliveryEnrichmentFixture(
  collection: LabelCollectedProduct,
): SharedEnrichmentRecord {
  const hash = "a".repeat(64);
  return {
    codec: "product-enrichment/3",
    enrichmentId: hash,
    formulaHash: hash,
    inputHash: hash,
    provider: "codex",
    createdAt: "2026-10-09T03:00:00.000Z",
    variantCode: hash,
    evidenceKey: "enrichment/result",
    promptSha256: hash,
    responseSha256: hash,
    subject: {
      channel: "dtc",
      listingId: collection.observation.listingId,
      variantId: collection.observation.variantId,
      collectionOperationId: collection.operationId,
      observation: collection.observation,
      title: "FocusFuel Gummies 30 Count",
      titleEvidence: null,
    },
    candidate: {
      unifiedName: "FocusFuel Gummies 30 Count",
      baseName: "FocusFuel",
      form: "gummy",
      variant: { count: 30, size: null, flavor: null, strength: null },
      healthFunctions: ["Focus"],
      functionalIngredients: ["L-Theanine"],
      inferredHealthFunctions: ["Sleep"],
      confidence: 0.87,
      notes: null,
    },
  };
}
