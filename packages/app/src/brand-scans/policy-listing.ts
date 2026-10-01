import { setTimeout } from "node:timers/promises";
import type { ListingScanOutcome } from "@crawl-automation/channels-core";
import type { BrandListing } from "./scan-listing-model.js";
import { pageReads, type ListingWork } from "./http-listing-pages.js";

/** Reader policies still share the HTTP archive, configured pacing and cancellation. */
export async function readPolicyListing(
  work: ListingWork,
  signal: AbortSignal,
): Promise<ListingScanOutcome | undefined> {
  return work.reader.readList?.({
    sourceUrl: work.reader.sourceUrl(work.scan.source.url),
    signal,
    read: pageReads(work, signal).read,
    pause: async (milliseconds) => {
      signal.throwIfAborted();
      await work.checkpoint?.();
      if (milliseconds > 0) {
        await setTimeout(milliseconds, undefined, { signal });
      }
      await work.checkpoint?.();
    },
  });
}

/** Keep the first occurrence, including its URL and title, across repeated observations. */
export function policyListing(outcome: ListingScanOutcome): BrandListing {
  const products = new Map<string, BrandListing["products"][number]>();
  for (const page of outcome.pages) {
    for (const product of page.products) {
      const key = `${product.listingId}\u0000${product.variantId ?? ""}`;
      if (!products.has(key)) {
        products.set(key, product);
      }
    }
  }
  return {
    ...outcome,
    products: [...products.values()],
    families: 0,
    unresolvedFamilies: 0,
    full: outcome.complete,
  };
}
