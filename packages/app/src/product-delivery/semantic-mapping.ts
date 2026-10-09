import type { SharedEnrichmentRecord } from "@crawl-automation/v3-contracts";
import type { DeliveryListing } from "./wire.js";

export function deliverySemantics(
  enrichment: SharedEnrichmentRecord | null,
): Partial<DeliveryListing> {
  if (!enrichment) {
    return {};
  }
  const candidate = enrichment.candidate;
  const variant: NonNullable<DeliveryListing["variant"]> = {};
  for (const key of ["flavor", "strength"] as const) {
    const value = candidate.variant[key];
    if (value) {
      variant[key] = value;
    }
  }
  const form = ["unknown", "other"].includes(candidate.form) ? undefined : candidate.form;
  if (form) {
    variant.form = form;
  }
  if (candidate.variant.size) {
    variant.size = candidate.variant.size;
  } else if (candidate.variant.count) {
    variant.size = `${candidate.variant.count} count`;
  }
  return {
    baseName: candidate.baseName,
    ...(form ? { productForm: form } : {}),
    healthFunctions: candidate.healthFunctions,
    ...mainIngredients(candidate.functionalIngredients),
    ...(Object.keys(variant).length
      ? {
          variant,
          variantConfidence: Math.round(candidate.confidence * 100),
          variantSource: "ai_extract" as const,
        }
      : {}),
  };
}

function mainIngredients(value: string[] | undefined) {
  return value ? { mainIngredients: value } : {};
}
