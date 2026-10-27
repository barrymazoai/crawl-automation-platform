import type { AmazonListingDate, AmazonSalesRank } from "@crawl-automation/v3-contracts";

export interface ListingDateWarning {
  reason: "missing" | "unreadable" | "hash_mismatch" | "identity_mismatch" | "history_unavailable";
  code?: string;
}

/**
 * Unavailable evidence is distinct from a readable page on which DFA is absent (null). The same reparse of the
 * retained original also yields the root sales rank (KAN-226), so a resend can estimate units for old captures.
 */
export type ListingDateRead =
  | { dateFirstAvailable: AmazonListingDate | null; salesRank: AmazonSalesRank | null }
  | { dateFirstAvailableWarning: ListingDateWarning };
