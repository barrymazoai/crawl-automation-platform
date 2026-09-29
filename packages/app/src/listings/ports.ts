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
  undelivered(limit: number): Promise<ListingObservation[]>;
  /** Records that the product database accepted these sightings (a final answer; failures are not recorded). */
  markDelivered(results: DeliveredSighting[]): Promise<void>;
}

/** The product database's final answer for one sighting. */
export interface DeliveredSighting {
  observationId: string;
  status: "ok" | "unknown_listing";
  response: unknown;
}

/** One item of `product.ingestListingStateBatch`, as the 09-18 design names it. */
export interface ListingStateItem {
  clientRef: string;
  listing: { channel: string; externalId: string; variantId: string | null };
  capturedAt: string;
  state: ListingObservation["state"];
  evidence: ListingObservation["evidence"] & { observationId: string };
  source: string;
}

export interface ListingStateBatch {
  run: { runId: string; channel: string; scope: "partial"; source: string; startedAt: string };
  items: ListingStateItem[];
}

/** Sends a batch to the product database and reads its answer back per item. */
export interface ListingStateSender {
  send(batch: ListingStateBatch): Promise<DeliveredSighting[]>;
}
