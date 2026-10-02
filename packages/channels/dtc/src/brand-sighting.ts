import type { FetchedPage, ListingSighting } from "@crawl-automation/channels-core";
import { dtcProductAddress, siteForUrl } from "./address.js";
import { assertDtcBrandVerified, dtcBrandEvidence } from "./brand-evidence.js";
import type { DtcBrandSource } from "./brand-source.js";
import { dtcEvidenceErrors } from "./evidence-errors.js";
import { readDtcProduct } from "./product.js";
import type { DtcSitePolicy } from "./site-policy.js";

/** The same SKU can be valid for B and unlisted under A; only its own page decides. */
export function dtcBrandSighting(
  page: FetchedPage,
  scope: { sites: readonly DtcSitePolicy[]; source: DtcBrandSource | null },
): Omit<ListingSighting, "archiveKey"> | null {
  const site = siteForUrl(page.url, scope.sites);
  if (site.kind === "single-brand") {
    return null;
  }
  const product = readDtcProduct(page, scope.sites);
  const evidence = dtcBrandEvidence(site, product.brandRaw, scope.source);
  if (evidence.status !== "mismatch") {
    assertDtcBrandVerified(evidence);
    return null;
  }
  const requested = dtcProductAddress(page.url, scope.sites);
  return {
    state: "unlisted",
    reason: "identity_conflict",
    causeCode: dtcEvidenceErrors.code("DTC.BRAND_MISMATCH"),
    httpStatus: 200,
    requestedListingId: requested.listingId,
    requestedVariantId: requested.variantId,
    observedListingId: dtcProductAddress(product.url, scope.sites).listingId,
    observedVariantId: product.selectedVariantId,
    finalUrl: null,
  };
}
