import type { HistoryListing } from "./listing-identity.js";

/** One history point: a listing's metrics (or formula) at a time, with the record it came from. */
export interface HistoryObservation {
  id: string;
  listingId: string;
  kind: "metrics" | "formula";
  observedAt: string | null;
  record: Record<string, unknown>;
}

/**
 * One source record for the history tables (product_history_source and the listing and observation rows it adds),
 * in the shape the earlier history store wrote.
 */
export interface HistoryEntry {
  id: string;
  dataset: string;
  sourceKey: string;
  bodyHash: string;
  raw: Record<string, unknown>;
  listings: HistoryListing[];
  observations: HistoryObservation[];
  issues: string[];
}

/** The append-only history tables. Adding the same entry again adds nothing; a different one is a conflict. */
export interface ProductHistoryStore {
  append(entry: HistoryEntry): Promise<{ inserted: boolean }>;
}
