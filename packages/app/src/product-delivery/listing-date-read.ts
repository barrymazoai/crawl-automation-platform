import type { AmazonListingDate } from "@crawl-automation/v3-contracts";

export interface ListingDateWarning {
  reason: "missing" | "unreadable" | "hash_mismatch" | "identity_mismatch" | "history_unavailable";
  code?: string;
}

/** Unavailable evidence is distinct from a readable page on which DFA is absent (null). */
export type ListingDateRead =
  | { dateFirstAvailable: AmazonListingDate | null }
  | { dateFirstAvailableWarning: ListingDateWarning };
