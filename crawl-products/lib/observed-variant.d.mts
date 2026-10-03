import type { readObservedProduct } from "./observed-product.mjs";
export function readPreflightVariantContexts(root: string): Promise<Array<Record<string, unknown>>>;
export function readObservedVariant(root: string, base: {
  productUrl?: string;
  sourceUrl?: string;
  variants: Array<Record<string, unknown>>;
  gallery?: Array<{ url: string; localPath?: string }>;
}, context: {
  status: "observed" | "mixed";
  variantId: string;
  basis: "variant-state" | "website-shared";
  sharedScope?: { rule: unknown; text: string };
  selectedState?: { rule: unknown; value: string } | undefined;
  galleryUrls?: string[];
  galleryReview?: Array<{ url: string; status: string; basis?: string | undefined; reason: string; evidence: string[] }>;
}, method: unknown): ReturnType<typeof readObservedProduct>;
