import type { BrandListing } from "./scan-listing.js";
import type { ScanResult } from "./scan-model.js";

/** Preserve policy accounting and error codes even when a read returns a usable partial list. */
export function listingScanResult(
  listing: BrandListing,
): Omit<ScanResult, "newListings" | "knownListings" | "missing" | "queued"> {
  return {
    state: listing.full
      ? "complete"
      : listing.code && !listing.products.length
        ? "review"
        : "partial",
    pages: listing.pages.length,
    products: listing.products.length,
    families: listing.families,
    unresolvedFamilies: listing.unresolvedFamilies,
    statedTotal:
      listing.statedTotal === undefined
        ? (listing.pages.at(-1)?.statedTotal ?? null)
        : listing.statedTotal,
    full: listing.full,
    capped: listing.capped ?? false,
    credits: listing.credits,
    code: listing.code ?? null,
    ...policyFields(listing),
  };
}

function policyFields(listing: BrandListing) {
  return {
    ...(listing.metrics ? { metrics: listing.metrics } : {}),
    ...(listing.cooldownRequested === undefined
      ? {}
      : { cooldownRequested: listing.cooldownRequested }),
    ...(listing.soldHere === undefined ? {} : { soldHere: listing.soldHere }),
    ...(listing.nameResolution ? { nameResolution: listing.nameResolution } : {}),
  };
}
