import type { BrandListing } from "./scan-listing.js";
import type { ScanExclusions } from "./scan-model.js";

/** What the scan's supplement judgement kept out of the queue, one entry per product. */
export function scanExclusions(listing: BrandListing): ScanExclusions | null {
  const variants = listing.products.filter((product) => product.excluded);
  if (variants.length === 0) {
    return null;
  }
  const items = new Map<string, ScanExclusions["items"][number]>();
  for (const product of variants) {
    if (!product.excluded || items.has(product.listingId)) {
      continue;
    }
    const url = new URL(product.url);
    url.search = "";
    items.set(product.listingId, {
      listingId: product.listingId,
      url: url.href,
      title: product.title,
      ...product.excluded,
    });
  }
  return { products: items.size, variants: variants.length, items: [...items.values()] };
}
