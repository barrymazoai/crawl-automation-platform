import { errorCodeOf } from "@crawl-automation/platform";
import type { ChannelAdapter, ProductAddress } from "../adapter.js";
import { channelErrors } from "../errors.js";

/**
 * What a direct revisit showed about a known listing when its page is no longer that product
 * (docs/quality/2026-09-18-product-service-listing-state-prompt.md). It is an observation only: the crawler never
 * marks a listing delisted; the product database decides.
 */
export interface ListingSighting {
  state: "gone" | "superseded";
  /** Why: the capture's own code for a missing page, or `LISTING.*` for a redirect. */
  causeCode: string;
  httpStatus: number | null;
  /** The listing the page belongs to now; always set for `superseded`. */
  observedListingId: string | null;
  /** Where the page that showed it is archived, when one was archived. */
  archiveKey: string | null;
}

/** A page that answered 404 or 410 is gone; any other failure is not a sighting. */
export function goneSighting(error: unknown): ListingSighting | null {
  if (!channelErrors.is(error, "CAPTURE.NOT_FOUND")) {
    return null;
  }
  const status = error.details["status"];
  return {
    state: "gone",
    causeCode: "CAPTURE.NOT_FOUND",
    httpStatus: typeof status === "number" ? status : null,
    observedListingId: null,
    archiveKey: null,
  };
}

/**
 * A page reached through a same-site redirect. Landing on the same listing is still that product (e.g. an address
 * with a different slug); landing on another product's address means the listing was superseded; landing on an
 * address that is no product at all means the listing is gone.
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
  const sighting = { httpStatus: 200, archiveKey: moved.archiveKey };
  if (!landed) {
    return {
      ...sighting,
      state: "gone",
      causeCode: "LISTING.REDIRECTED_AWAY",
      observedListingId: null,
    };
  }
  return {
    ...sighting,
    state: "superseded",
    causeCode: "LISTING.SUPERSEDED",
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
