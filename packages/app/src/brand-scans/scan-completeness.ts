import type { BrandListing } from "./scan-listing-model.js";

/** Recheck count proof at the queue boundary, including results from older remote workers. */
export function hasScanTotalProof(listing: BrandListing): boolean {
  const { metrics, statedTotal } = listing;
  if (!listing.full || listing.code || !statedTotal || !metrics?.readsFinished) {
    return false;
  }
  const reads = metrics.reads.filter((read) => read.read !== "canary");
  const unique = new Set(listing.products.map((product) => product.listingId)).size;
  return (
    reads.length === 2 &&
    unique === statedTotal &&
    metrics.unionSize === unique &&
    reads.every(
      (read) =>
        read.code === null &&
        read.availableCounts.includes(statedTotal) &&
        read.availableCounts.every((count) => count === 0 || count === statedTotal),
    )
  );
}
