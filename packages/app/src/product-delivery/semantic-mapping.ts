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
    healthFunctions: healthFunctions(candidate),
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

/**
 * Printed health functions; when none is printed, those inferred from the main ingredients (owner 2026-10-26).
 * Grounding keeps inferred ones only when none is printed and main ingredients exist.
 */
function healthFunctions(candidate: SharedEnrichmentRecord["candidate"]) {
  return candidate.healthFunctions.length
    ? candidate.healthFunctions
    : (candidate.inferredHealthFunctions ?? []);
}

function mainIngredients(value: string[] | undefined) {
  return value ? { mainIngredients: value } : {};
}
