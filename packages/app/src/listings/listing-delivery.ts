import type { ListingObservation } from "./listing-model.js";
import type {
  ListingStateBatch,
  ListingStateItem,
  ListingStateSender,
  ListingStateStore,
} from "./ports.js";

/** The product database accepts at most 200 sightings per request (09-18 design). */
const BATCH_LIMIT = 200;
const SOURCE = "crawler-v3:listing-state";

/** One batch per channel, in the shape of `product.ingestListingStateBatch`. */
export function listingStateBatches(
  observations: ListingObservation[],
  startedAt: string,
): ListingStateBatch[] {
  const byChannel = new Map<string, ListingObservation[]>();
  for (const observation of observations) {
    byChannel.set(observation.channel, [
      ...(byChannel.get(observation.channel) ?? []),
      observation,
    ]);
  }
  return [...byChannel].map(([channel, items]) => ({
    run: {
      runId: `listing-state-${startedAt}-${channel}`,
      channel,
      scope: "partial",
      source: SOURCE,
      startedAt,
    },
    items: items.map(batchItem),
  }));
}

function batchItem(observation: ListingObservation): ListingStateItem {
  const { channel, listingId, variantId, capturedAt } = observation;
  return {
    clientRef: `${channel}:${listingId}:${variantId ?? "-"}:${capturedAt}`,
    listing: { channel, externalId: listingId, variantId },
    capturedAt,
    state: observation.state,
    evidence: { ...observation.evidence, observationId: observation.observationId },
    source: observation.source,
  };
}

/**
 * Sends recorded sightings to the product database, when a sender is configured. Without one (the product
 * database's `ingestListingStateBatch` may not exist yet) every sighting stays stored and undelivered; nothing is
 * lost. Only a final per-item answer is recorded; a failed item stays undelivered for a later send.
 */
export class ListingStateDelivery {
  constructor(
    private readonly deps: {
      store: ListingStateStore;
      sender: ListingStateSender | null;
    },
  ) {}

  async deliverPending(startedAt: string): Promise<{ sent: number; held: number }> {
    const pending = await this.deps.store.undelivered(BATCH_LIMIT);
    const sender = this.deps.sender;
    if (!sender) {
      return { sent: 0, held: pending.length };
    }
    let sent = 0;
    for (const batch of listingStateBatches(pending, startedAt)) {
      const answers = await sender.send(batch);
      await this.deps.store.markDelivered(answers);
      sent += answers.length;
    }
    return { sent, held: pending.length - sent };
  }
}
