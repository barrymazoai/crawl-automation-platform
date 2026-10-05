/** Check website IDs against the collector's material index without extracting product content. */
export function assertMaterialVariantIds(variants, materials, observedVariants, options = {}) {
  if (!Array.isArray(variants) || !Array.isArray(materials?.variants)) {
    throw new Error("material_variant_inventory_required");
  }
  const ids = variantIds(variants);
  if (observedVariants !== undefined) {
    const observed = variantIds(observedVariants);
    if (observed.size !== ids.size || [...observed].some(id => !ids.has(id))) {
      throw new Error("material_website_variants_mismatch");
    }
  }
  if (materials.selectedVariantId != null && !ids.has(materials.selectedVariantId)) {
    throw new Error("material_selected_variant_unknown");
  }
  const scoped = new Set();
  for (const scope of materials.variants) {
    if (!scope || !ids.has(scope.variantId) || scoped.has(scope.variantId)) {
      throw new Error("material_variant_unknown_or_duplicate");
    }
    if (!["independent", "mixed", "unresolved"].includes(scope.status)) {
      throw new Error("material_variant_status_required");
    }
    scoped.add(scope.variantId);
  }
  // A single variant can use the base material; multiple variants need explicit states or reasons.
  // The host may accept missing states: those variants then use the base materials as a mixed scope.
  if (!options.allowMissingStates && ids.size > 1 && [...ids].some(id => !scoped.has(id))) {
    throw new Error("material_variant_state_missing");
  }
}

function variantIds(variants) {
  const ids = new Set();
  for (const variant of variants) {
    if (typeof variant?.variantId !== "string" || !variant.variantId || ids.has(variant.variantId)) {
      throw new Error("material_website_variant_id_invalid");
    }
    ids.add(variant.variantId);
  }
  return ids;
}
