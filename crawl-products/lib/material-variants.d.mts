export function assertMaterialVariantIds(
  variants: Array<{ variantId?: string | undefined }>,
  materials: { selectedVariantId: string | null; variants: unknown[] },
  observedVariants?: Array<{ variantId?: string | undefined }>,
  options?: { allowMissingStates?: boolean },
): void;
