import { errorCodeOf } from "@crawl-automation/platform";
import type { ChannelAdapter, ProductAddress, ProductIdentity } from "../adapter.js";
import { channelErrors } from "../errors.js";

/**
 * Why a revisited listing is unlisted (owner rule 2026-09-29, every channel): its page no longer exists, it redirects
 * to a different product, it redirects to a page that is no product, or the page shows another product's ID.
 */
export const UNLISTED_REASONS = [
  "not_found",
  "redirected_to_other_product",
  "redirected_away",
  "identity_conflict",
] as const;
export type UnlistedReason = (typeof UNLISTED_REASONS)[number];

/**
 * What a direct revisit showed about a known listing whose page is no longer that product
 * (docs/quality/2026-09-18-product-service-listing-state-prompt.md). It is an observation only: the crawler never
 * marks a listing delisted; the product database decides.
 */
export interface ListingSighting {
  state: "unlisted";
  reason: UnlistedReason;
  /** `LISTING.NOT_FOUND`, `LISTING.REDIRECTED_TO_OTHER_PRODUCT`, `LISTING.REDIRECTED_AWAY` or `LISTING.IDENTITY_CONFLICT`. */
  causeCode: string;
  httpStatus: number | null;
  /** The other product the page belongs to now: set for `redirected_to_other_product` and `identity_conflict`. */
  observedListingId: string | null;
  /** Both identities for a page conflict, including a mismatched selected variant. */
  requestedListingId?: string;
  requestedVariantId?: string | null;
  observedVariantId?: string | null;
  /** Where a redirect landed: set for `redirected_to_other_product` and `redirected_away`. */
  finalUrl: string | null;
  /** Where the page that showed it is archived, when one was archived. */
  archiveKey: string | null;
}

/** Compare page-owned IDs with the requested listing; the archive retains the requested ID and original bytes. */
export function identitySighting(
  requested: ProductIdentity,
  observed: ProductIdentity,
  archiveKey: string,
): ListingSighting | null {
  const sameVariant = requested.variantId === null || requested.variantId === observed.variantId;
  if (requested.listingId === observed.listingId && sameVariant) {
    return null;
  }
  return {
    state: "unlisted",
    reason: "identity_conflict",
    causeCode: "LISTING.IDENTITY_CONFLICT",
    httpStatus: 200,
    requestedListingId: requested.listingId,
    requestedVariantId: requested.variantId,
    observedListingId: observed.listingId,
    observedVariantId: observed.variantId,
    finalUrl: null,
    archiveKey,
  };
}

/** A page that answered 404 or 410 is unlisted (`not_found`); any other failure is not a sighting. */
export function notFoundSighting(error: unknown): ListingSighting | null {
  if (!channelErrors.is(error, "CAPTURE.NOT_FOUND")) {
    return null;
  }
  const status = error.details["status"];
  return {
    state: "unlisted",
    reason: "not_found",
    causeCode: "LISTING.NOT_FOUND",
    httpStatus: typeof status === "number" ? status : null,
    observedListingId: null,
    finalUrl: null,
    archiveKey: null,
  };
}

/**
 * A page reached through a same-site redirect. Landing on the same listing is still that product (e.g. an address
 * with a different slug). Landing on another product's address, or on an address that is no product at all, means
 * the listing is unlisted, with the reason and where it landed recorded.
 */
export function movedSighting(
  adapter: Pick<ChannelAdapter, "productAddress">,
  requested: ProductAddress,
  moved: { finalUrl: string; archiveKey: string },
): ListingSighting | null {
  const landed = landingAddress(adapter, moved.finalUrl);
  if (landed?.listingId === requested.listingId) {
    return null;
  }
  const sighting = {
    state: "unlisted" as const,
    httpStatus: 200,
    finalUrl: moved.finalUrl,
    archiveKey: moved.archiveKey,
  };
  if (!landed) {
    return {
      ...sighting,
      reason: "redirected_away",
      causeCode: "LISTING.REDIRECTED_AWAY",
      observedListingId: null,
    };
  }
  return {
    ...sighting,
    reason: "redirected_to_other_product",
    causeCode: "LISTING.REDIRECTED_TO_OTHER_PRODUCT",
    observedListingId: landed.listingId,
  };
}

/** The product address a redirect landed on; null when the adapter refuses it as a product address (by code). */
function landingAddress(
  adapter: Pick<ChannelAdapter, "productAddress">,
  url: string,
): ProductAddress | null {
  try {
    return adapter.productAddress(url);
  } catch (error) {
    if (errorCodeOf(error)) {
      return null;
    }
    throw error;
  }
}
