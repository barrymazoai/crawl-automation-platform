import type { BrandListing } from "./scan-listing.js";
import type { QueuedProduct } from "../queue/queue-model.js";

const keyOf = (item: { listingId: string; variantId: string | null }) =>
  `${item.listingId}\u0000${item.variantId ?? ""}`;

/** Listed products split into new and already known; known listings the listing no longer shows. */
export function compareScanListings(listing: BrandListing, known: QueuedProduct[]) {
  const knownKeys = new Set(known.map(keyOf));
  const listedKeys = new Set(listing.products.map(keyOf));
  const knownListings = [...listedKeys].filter((key) => knownKeys.has(key)).length;
  return {
    newListings: listedKeys.size - knownListings,
    knownListings,
    missing: known.filter((item) => !listedKeys.has(keyOf(item))),
  };
}
