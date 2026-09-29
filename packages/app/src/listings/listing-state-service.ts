import { sha256 } from "@crawl-automation/v3-artifacts";
import { appErrors } from "../errors.js";
import type { QueueService } from "../queue/queue-service.js";
import {
  ListingCountsQuerySchema,
  ListingQuerySchema,
  ListingSightingInputSchema,
  MissingFromScanSchema,
  type ListingCounts,
  type ListingObservation,
} from "./listing-model.js";
import type { ListingStateStore } from "./ports.js";
import { missingEvidence } from "./unlisted-evidence.js";

/** Records one sighting once; its identity is the listing and the source that saw it. */
export async function recordSighting(
  store: Pick<ListingStateStore, "record">,
  raw: unknown,
): Promise<ListingObservation> {
  const sighting = ListingSightingInputSchema.parse(raw);
  const missing = missingEvidence(sighting);
  if (missing.length > 0) {
    throw appErrors.create("LISTING.REASON_EVIDENCE_MISSING", {
      details: { state: sighting.state, reason: sighting.reason, missing },
    });
  }
  const { channel, listingId, variantId, source } = sighting;
  const key = JSON.stringify(["listing-state/1", channel, listingId, variantId, source]);
  return store.record({ ...sighting, observationId: sha256(Buffer.from(key)) });
}

/**
 * Listing states for every channel: each sighting recorded once as a fact, listed and counted, and listings a full
 * brand scan no longer showed queued for a direct revisit. It never marks anything delisted.
 */
export class ListingStateService {
  constructor(
    private readonly deps: {
      store: ListingStateStore;
      queue: Pick<QueueService, "add">;
    },
  ) {}

  /** Records one sighting. The same source seeing the same listing again returns the first record. */
  async record(raw: unknown): Promise<ListingObservation> {
    return recordSighting(this.deps.store, raw);
  }

  async list(raw: unknown): Promise<ListingObservation[]> {
    return this.deps.store.list(ListingQuerySchema.parse(raw));
  }

  async counts(raw: unknown): Promise<ListingCounts> {
    return this.deps.store.counts(ListingCountsQuerySchema.parse(raw));
  }

  /**
   * Queues a direct revisit for each listing a full scan no longer showed. The revisit's own sighting (unlisted
   * with its reason, or live) is what gets recorded; absence alone never is.
   */
  async requestRevisits(raw: unknown): Promise<{ queued: number }> {
    const missing = MissingFromScanSchema.parse(raw);
    const { channel, batchId, label, listings } = missing;
    const { added } = await this.deps.queue.add({ channel, batchId, label, products: listings });
    return { queued: added };
  }
}
