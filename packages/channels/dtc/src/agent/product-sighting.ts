import type { BrowserCaptureResult, CaptureRequest } from "@crawl-automation/channels-core";
import { dtcProductAddress } from "../address.js";
import { dtcBrandEvidence } from "../brand-evidence.js";
import { dtcBrandSource } from "../brand-source.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { HarvestRecord, CaptureReview } from "./product-record.js";
import { capturedProductBrand } from "./product-brand.js";

/** An observed different brand retains the existing source-specific unlisted outcome. */
export function capturedBrandSighting(input: {
  request: CaptureRequest;
  site: DtcSitePolicy;
  record: HarvestRecord;
  review: CaptureReview;
  archiveKey: string;
  html?: Uint8Array;
}): Extract<BrowserCaptureResult, { status: "sighted" }> | null {
  const { request, site, review, archiveKey } = input;
  const source = request.sourceUrl ? dtcBrandSource(request.sourceUrl, [site]) : null;
  const brand = capturedProductBrand({ ...input, url: request.url });
  if (dtcBrandEvidence(site, brand, source).status !== "mismatch") {
    return null;
  }
  const address = dtcProductAddress(request.url, [site]);
  return {
    status: "sighted",
    listingId: address.listingId,
    variantId: address.variantId,
    sighting: {
      state: "unlisted",
      reason: "identity_conflict",
      causeCode: "DTC.BRAND_MISMATCH",
      httpStatus: 200,
      requestedListingId: address.listingId,
      requestedVariantId: address.variantId,
      observedListingId: address.listingId,
      observedVariantId: review.selectedVariantId,
      finalUrl: null,
      archiveKey,
    },
  };
}
