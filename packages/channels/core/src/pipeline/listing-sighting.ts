import { listingErrors } from "@crawl-automation/platform";
import { errorCodeOf } from "@crawl-automation/platform";
import type { ChannelAdapter, ProductAddress, ProductIdentity } from "../adapter.js";
import { channelErrors } from "../errors.js";

export * from "./listing-sighting-model.js";
import type { ListingSighting } from "./listing-sighting-model.js";

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
    causeCode: listingErrors.code("LISTING.IDENTITY_CONFLICT"),
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
    causeCode: listingErrors.code("LISTING.NOT_FOUND"),
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
      causeCode: listingErrors.code("LISTING.REDIRECTED_AWAY"),
      observedListingId: null,
    };
  }
  return {
    ...sighting,
    reason: "redirected_to_other_product",
    causeCode: listingErrors.code("LISTING.REDIRECTED_TO_OTHER_PRODUCT"),
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
