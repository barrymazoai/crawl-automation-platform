import { describe, expect, it } from "vitest";
import type { QueuedProduct } from "../queue/queue-model.js";
import { compareScanListings } from "./scan-comparison.js";
import type { BrandListing } from "./scan-listing.js";

const known = (listingId: string, variantId: string | null): QueuedProduct => ({
  sourceId: "00000000-0000-4000-8000-000000000001",
  url: `https://example.com/products/${listingId}${variantId ? `?variant=${variantId}` : ""}`,
  listingId,
  variantId,
});
const listing = (...items: QueuedProduct[]): BrandListing => ({
  pages: [],
  products: items.map((item) => ({ ...item, title: null, kind: "product" })),
  families: 0,
  unresolvedFamilies: 0,
  credits: 0,
  full: true,
});

describe("scan comparison with earlier base addresses", () => {
  it("keeps exact variant matches and counts a different variant as new", () => {
    expect(
      compareScanListings(listing(known("a", "1"), known("a", "2")), [known("a", "1")]),
    ).toMatchObject({ newListings: 1, knownListings: 1, missing: [] });
  });

  it("matches only the variant collected from an earlier base-address run", () => {
    const base = known("a", null);
    const observed = new Map([["a", new Set(["2"])]]);
    expect(
      compareScanListings(listing(known("a", "1"), known("a", "2")), [base], observed),
    ).toEqual({ newListings: 1, knownListings: 1, missing: [] });
  });

  it("treats an uncollected base address as known for every listed variant", () => {
    expect(
      compareScanListings(listing(known("a", "1"), known("a", "2")), [known("a", null)]),
    ).toEqual({ newListings: 0, knownListings: 2, missing: [] });
  });

  it("revisits a base address only when its whole listing disappears", () => {
    const base = known("a", null);
    expect(compareScanListings(listing(known("b", "1")), [base]).missing).toEqual([base]);
  });

  it("keeps exact-key behavior for Amazon-style listings", () => {
    const base = known("B002CQU54Q", null);
    expect(compareScanListings(listing(base), [base])).toEqual({
      newListings: 0,
      knownListings: 1,
      missing: [],
    });
    expect(compareScanListings(listing(known("B999999999", null)), [base])).toEqual({
      newListings: 1,
      knownListings: 0,
      missing: [base],
    });
  });
});
