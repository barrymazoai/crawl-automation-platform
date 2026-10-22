import type { BrandListing } from "./scan-listing.js";
import type { QueuedProduct } from "../queue/queue-model.js";

const keyOf = (item: { listingId: string; variantId: string | null }) =>
  `${item.listingId}\u0000${item.variantId ?? ""}`;

/** Listed products split into new and already known; known listings the listing no longer shows. */
export function compareScanListings(
  listing: BrandListing,
  known: QueuedProduct[],
  observedBaseVariants: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
) {
  const knownKeys = new Set(known.map(keyOf));
  const listedKeys = new Set(listing.products.map(keyOf));
  const baseIds = new Set(
    known.filter((item) => item.variantId === null).map((item) => item.listingId),
  );
  const uniqueListed = new Map(listing.products.map((item) => [keyOf(item), item]));
  const knownListings = [...uniqueListed.values()].filter((item) => {
    if (knownKeys.has(keyOf(item))) {
      return true;
    }
    if (item.variantId === null || !baseIds.has(item.listingId)) {
      return false;
    }
    const observed = observedBaseVariants.get(item.listingId);
    return !observed?.size || observed.has(item.variantId);
  }).length;
  const listedIds = new Set(listing.products.map((item) => item.listingId));
  return {
    newListings: listedKeys.size - knownListings,
    knownListings,
    missing: known.filter(
      (item) =>
        !listedKeys.has(keyOf(item)) && (item.variantId !== null || !listedIds.has(item.listingId)),
    ),
  };
}
