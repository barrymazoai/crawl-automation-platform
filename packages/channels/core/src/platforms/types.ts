import type { CommerceEvidence, FactsText } from "../adapter.js";

export type StorePlatform = "shopify" | "woocommerce" | "jsonld";
export type JsonObject = Record<string, unknown>;

/** A caller supplies the DOM; readers never fetch a page or execute its scripts. */
export interface PlatformContext {
  url: string;
  siteKey: string;
  imageOrigins: readonly string[];
  productSelector?: string;
}

export interface PlatformVariant {
  id: string;
  title: string | null;
  url: string;
  price: string | null;
  availability: string | null;
  image: string | null;
}

export interface PlatformProduct {
  platform: StorePlatform;
  productId: string;
  url: string;
  title: string;
  brandRaw: string | null;
  selectedVariantId: string | null;
  variants: PlatformVariant[];
  commerce: CommerceEvidence;
  detailsHtml: string | null;
  facts: FactsText;
  factsHtml: string | null;
  images: string[];
}

export interface PlatformCatalog {
  products: {
    url: string;
    productId: string | null;
    title: string | null;
    brandRaw: string | null;
  }[];
  nextUrl: string | null;
  empty: boolean;
}
