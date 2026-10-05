import type { BrandListing } from "./scan-listing-model.js";

type ScanReads = NonNullable<BrandListing["metrics"]>["reads"];

/** Recheck count proof at the queue boundary, including results from older remote workers. */
export function hasScanTotalProof(listing: BrandListing): boolean {
  const { metrics, statedTotal } = listing;
  if (!listing.full || listing.code || !statedTotal || !metrics?.readsFinished) {
    return false;
  }
  const reads = metrics.reads.filter((read) => read.read !== "canary");
  if (reads.length !== 2 || reads.some((read) => read.code !== null)) {
    return false;
  }
  // The search API restates a different total on each call (owner 2026-10-05): two reads that are each
  // complete against their own total also prove the list; the union is the product set.
  return consistentTotal(listing, reads, statedTotal) || reads.every((read) => read.succeeded);
}

function consistentTotal(listing: BrandListing, reads: ScanReads, total: number) {
  const unique = new Set(listing.products.map((product) => product.listingId)).size;
  return (
    unique === total &&
    listing.metrics?.unionSize === unique &&
    reads.every(
      (read) =>
        read.availableCounts.includes(total) &&
        read.availableCounts.every((count) => count === 0 || count === total),
    )
  );
}
