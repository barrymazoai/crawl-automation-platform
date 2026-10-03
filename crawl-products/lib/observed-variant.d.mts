import type { readObservedProduct } from "./observed-product.mjs";
export function readObservedVariant(root: string, base: {
  productUrl?: string;
  sourceUrl?: string;
  variants: Array<Record<string, unknown>>;
}, context: {
  status: "observed";
  variantId: string;
  basis: "variant-state" | "website-shared";
  sharedScope?: { rule: unknown; text: string };
}, method: unknown): ReturnType<typeof readObservedProduct>;
