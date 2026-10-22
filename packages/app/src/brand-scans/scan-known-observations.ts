import type { QueuedProduct } from "../queue/queue-model.js";
import type { BrandListing } from "./scan-listing.js";
import type { ScanRecord } from "./scan-model.js";
import type { BrandScanStore } from "./ports.js";
import { compareScanListings } from "./scan-comparison.js";

/** Read only observations that can change comparison with an older base-address listing. */
export async function compareKnownScanListings(input: {
  store: BrandScanStore;
  scan: ScanRecord;
  listing: BrandListing;
  known: QueuedProduct[];
}) {
  const { store, scan, listing, known } = input;
  if (scan.source.channel === "amazon") {
    return compareScanListings(listing, known);
  }
  const variantListingIds = new Set(
    listing.products.filter((item) => item.variantId !== null).map((item) => item.listingId),
  );
  const baseIds = known
    .filter((item) => item.variantId === null && variantListingIds.has(item.listingId))
    .map((item) => item.listingId);
  const observed = baseIds.length
    ? await store.observedBaseVariants(scan.source, scan.scanId, baseIds)
    : new Map<string, Set<string>>();
  return compareScanListings(listing, known, observed);
}
