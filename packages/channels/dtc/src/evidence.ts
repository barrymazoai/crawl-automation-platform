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

function productImages(product: PlatformProduct, site: DtcSitePolicy) {
  const galleries = product.images.map((url) => ({
    url,
    variantId: null,
    basis: "product-gallery" as const,
    verifiedOriginal: false as const,
  }));
  const featured = product.variants.flatMap((variant) => {
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
            scope: product.variants.length > 1 ? "product-unassigned-variant" : "selected-product",
          },
        ]
      : [],
    imageCandidates: productImages(product, site),
    warnings: [
      ...dtcBrandWarnings(brandEvidence),
      ...(product.variants.length > 1
        ? [dtcEvidenceErrors.code("DTC.FACTS_VARIANT_UNASSIGNED")]
        : []),
    ],
  });
}
