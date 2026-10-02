/**
 * Why a revisited listing is unlisted (owner rule 2026-09-29, every channel): its page no longer exists, it redirects
 * to a different product, it redirects to a page that is no product, or the page shows another product's ID.
 */
export const UNLISTED_REASONS = [
  "not_found",
  "redirected_to_other_product",
  "redirected_away",
  "identity_conflict",
] as const;
export type UnlistedReason = (typeof UNLISTED_REASONS)[number];

/**
 * What a direct revisit showed about a known listing whose page is no longer that product
 * (docs/quality/2026-09-18-product-service-listing-state-prompt.md). It is an observation only: the crawler never
 * marks a listing delisted; the product database decides.
 */
export interface ListingSighting {
  state: "unlisted";
  reason: UnlistedReason;
  /** `LISTING.NOT_FOUND`, `LISTING.REDIRECTED_TO_OTHER_PRODUCT`, `LISTING.REDIRECTED_AWAY` or `LISTING.IDENTITY_CONFLICT`. */
  causeCode: string;
  httpStatus: number | null;
  /** The other product the page belongs to now: set for `redirected_to_other_product` and `identity_conflict`. */
  observedListingId: string | null;
  /** Both identities for a page conflict, including a mismatched selected variant. */
  requestedListingId?: string;
  requestedVariantId?: string | null;
  observedVariantId?: string | null;
  /** Where a redirect landed: set for `redirected_to_other_product` and `redirected_away`. */
  finalUrl: string | null;
  /** Where the page that showed it is archived, when one was archived. */
  archiveKey: string | null;
}
