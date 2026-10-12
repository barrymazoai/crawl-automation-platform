import type {
  ListingCounts,
  ListingCountsQuery,
  ListingObservation,
  ListingQuery,
  ListingSightingInput,
} from "./listing-model.js";

/** A sighting as it is stored: its input plus the observation ID derived from it. */
export interface NewListingObservation extends ListingSightingInput {
  observationId: string;
}

/** `listing_state_observation`: sightings written once and never changed. */
export interface ListingStateStore {
  /** Writes once and reads back; the same ID with a different sighting is a conflict. */
  record(observation: NewListingObservation): Promise<ListingObservation>;
  list(query: ListingQuery): Promise<ListingObservation[]>;
  counts(query: ListingCountsQuery): Promise<ListingCounts>;
  /** Sightings not yet sent to the product database, oldest first. */
  undelivered(filter: UndeliveredFilter): Promise<ListingObservation[]>;
  /** Records that the product database accepted these sightings (a final answer; failures are not recorded). */
  markDelivered(results: DeliveredSighting[]): Promise<void>;
}

/** The product database's final answer for one sighting. */
export interface DeliveredSighting {
  observationId: string;
  status: "ok" | "unknown_listing";
  response: unknown;
}

export interface UndeliveredFilter {
  limit: number;
  channels: readonly string[];
  state: ListingObservation["state"];
}

/** One item of `product.ingestListingStateBatch` (Supply Smart SUPPLYSMAR-380, unchanged since 2026-09-18). */
export interface ListingStateItem {
  clientRef: string;
  /** Supply Smart finds the listing by exact channel + external ID; it has no variant field. */
  listing: { channel: string; externalId: string };
  capturedAt: string;
  /** The product service's own states; every unlisted reason is `gone` there (see listing-delivery.ts). */
  state: "gone" | "live";
  /** Supply Smart's `artifactKey` is optional but never null, so an absent key is left out. */
  evidence: Omit<ListingObservation["evidence"], "artifactKey"> & {
    artifactKey?: string;
    observationId: string;
    reason: ListingObservation["reason"];
  };
  source: string;
}

export interface ListingStateBatch {
  run: { runId: string; channel: string; scope: "partial"; source: string; startedAt: string };
  items: ListingStateItem[];
}

/** The product database's answer for one item; `failed` is not final and the sighting stays undelivered. */
export interface ListingStateAnswer {
  clientRef: string;
  status: "ok" | "failed" | "unknown_listing";
  response: unknown;
}

/** Sends a batch to the product database and returns its answer per item. */
export interface ListingStateSender {
  send(batch: ListingStateBatch, signal: AbortSignal): Promise<ListingStateAnswer[]>;
}

/**
 * The Supply Smart external IDs a sighting covers: the IDs its listing was synced under (one per variant for a
 * variant-level channel), else its own variant or listing ID.
 */
export interface ListingTargets {
  externalIds(sightings: ListingObservation[]): Promise<Map<string, string[]>>;
}
