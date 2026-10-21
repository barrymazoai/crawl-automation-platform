import { dtcEvidenceErrors } from "./evidence-errors.js";
import { imageUrls, type FactsText, type PlatformProduct } from "@crawl-automation/channels-core";
import {
  ChannelProductEvidenceSchema,
  type ChannelProductEvidence,
} from "@crawl-automation/v3-contracts";
import type { DtcSitePolicy } from "./site-policy.js";
import { dtcIdentityKey } from "./identity.js";
import { dtcBrandWarnings, type DtcBrandEvidence } from "./brand-evidence.js";

export interface DtcRendered {
  siteKey: string;
  productId: string;
  brandEvidence: DtcBrandEvidence;
  evidence: ChannelProductEvidence;
  facts: FactsText;
  platform: PlatformProduct["platform"];
}

/**
 * Step 2 (owner 2026-10-21): the task's variant owns the gallery (the sole variant, or the one the page or the
 * `?variant=` address selected); a base page of a multi-variant product with no selection keeps it unassigned, as
 * the product-level task. Only the owning variant's featured image joins: another variant's image is not this task's.
 */
function productImages(product: PlatformProduct, site: DtcSitePolicy) {
  const owner = product.selectedVariantId;
  const galleries = product.images.map((url) => ({
    url,
    variantId: owner,
    basis: "product-gallery" as const,
    verifiedOriginal: false as const,
  }));
  const owned = product.variants.filter((variant) => variant.id === owner);
  const featured = owned.flatMap((variant) => {
    const urls = imageUrls(variant.image ? [variant.image] : [], {
      url: product.url,
      siteKey: site.siteKey,
      imageOrigins: site.imageOrigins,
    });
    return urls.map((url) => ({
      url,
      variantId: variant.id,
      basis: "variant-featured" as const,
      verifiedOriginal: false as const,
    }));
  });
  return [...galleries, ...featured];
}

export function dtcEvidence(
  product: PlatformProduct,
  site: DtcSitePolicy,
  brandEvidence: DtcBrandEvidence,
): ChannelProductEvidence {
  const listingId = dtcIdentityKey(site.siteKey, product.productId);
  return ChannelProductEvidenceSchema.parse({
    codec: "channel-product/1",
    channel: "dtc",
    listingId,
    variantId: product.selectedVariantId,
    url: product.url,
    title: product.title,
    brandRaw: site.kind === "single-brand" ? site.siteKey : product.brandRaw,
    variantOptions: [],
    variants: product.variants.map((variant) => ({
      listingId,
      variantId: variant.id,
      title: variant.title,
      url: variant.url,
    })),
    detailsHtml: product.detailsHtml,
    factsCandidates: product.factsHtml
      ? [
          {
            field: "supplement-facts",
            html: product.factsHtml,
            // The page's facts block belongs to the task's variant or, without a selection, to the base product.
            scope: "selected-product",
          },
        ]
      : [],
    imageCandidates: productImages(product, site),
    warnings: [
      ...dtcBrandWarnings(brandEvidence),
      ...(product.variants.length > 1
        ? [dtcEvidenceErrors.code("DTC.GALLERY_SHARED_WITH_VARIANT")]
        : []),
    ],
  });
}
