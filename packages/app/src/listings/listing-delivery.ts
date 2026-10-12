import type { ListingObservation } from "./listing-model.js";
import type {
  DeliveredSighting,
  ListingStateAnswer,
  ListingStateBatch,
  ListingStateItem,
  ListingStateSender,
  ListingStateStore,
  ListingTargets,
} from "./ports.js";

/** The product database accepts at most 200 items per request (SUPPLYSMAR-380). */
const BATCH_LIMIT = 200;
const SOURCE = "crawler-v3:listing-state";

/** One request's items and which sighting each item (by clientRef) belongs to. */
export interface PlannedListingBatch {
  batch: ListingStateBatch;
  owners: Map<string, string>;
}

/**
 * Requests of at most 200 items per channel, in the shape of `product.ingestListingStateBatch`. A sighting becomes one
 * item per external ID it covers, and all of them travel in the same request so its answer is complete.
 */
export function listingStateBatches(
  observations: ListingObservation[],
  targets: Map<string, string[]>,
  startedAt: string,
): PlannedListingBatch[] {
  const byChannel = new Map<string, ListingStateItem[][]>();
  for (const observation of observations) {
    const ids = targets.get(observation.observationId) ?? [
      observation.variantId ?? observation.listingId,
    ];
    byChannel.set(observation.channel, [
      ...(byChannel.get(observation.channel) ?? []),
      [...new Set(ids)].map((externalId) => batchItem(observation, externalId)),
    ]);
  }
  return [...byChannel].flatMap(([channel, sightings]) =>
    packed(sightings).map((items, index) => ({
      batch: {
        run: {
          runId: `listing-state-${startedAt}-${channel}${index ? `-${index + 1}` : ""}`,
          channel,
          scope: "partial" as const,
          source: SOURCE,
          startedAt,
        },
        items: items.map(({ item }) => item),
      },
      owners: new Map(items.map(({ item, observationId }) => [item.clientRef, observationId])),
    })),
  );
}

function packed(sightings: ListingStateItem[][]) {
  const requests: { item: ListingStateItem; observationId: string }[][] = [];
  for (const items of sightings) {
    const last = requests.at(-1);
    const entries = items.map((item) => ({ item, observationId: item.evidence.observationId }));
    if (last && last.length + entries.length <= BATCH_LIMIT) {
      last.push(...entries);
    } else {
      requests.push(entries);
    }
  }
  return requests;
}

/**
 * One sighting as the product service's item. Every unlisted reason is sent as `gone`: the owner's rule is that a
 * listing whose page is missing, redirects to a different product or away, or shows another product's ID is unlisted
 * in every case. The reason, the other product's ID (`observedExternalId`) and where a redirect landed travel as
 * evidence, so the product database still sees exactly why (and may link a successor from the observed ID).
 */
function batchItem(observation: ListingObservation, externalId: string): ListingStateItem {
  const { channel, capturedAt, reason } = observation;
  const { artifactKey, ...evidence } = observation.evidence;
  return {
    clientRef: `${channel}:${externalId}:${capturedAt}`,
    listing: { channel, externalId },
    capturedAt,
    state: observation.state === "unlisted" ? "gone" : "live",
    evidence: {
      ...evidence,
      ...(artifactKey ? { artifactKey } : {}),
      reason,
      observationId: observation.observationId,
    },
    source: observation.source,
  };
}

/** A sighting is delivered once every one of its items has a final answer (`ok` or `unknown_listing`). */
export function deliveredSightings(
  answers: ListingStateAnswer[],
  owners: Map<string, string>,
): DeliveredSighting[] {
  const bySighting = new Map<string, ListingStateAnswer[]>();
  for (const [clientRef, observationId] of owners) {
    const answer = answers.find((entry) => entry.clientRef === clientRef);
    const known = bySighting.get(observationId) ?? [];
    bySighting.set(observationId, answer ? [...known, answer] : [...known, missing(clientRef)]);
  }
  return [...bySighting].flatMap(([observationId, items]) =>
    items.some((item) => item.status === "failed")
      ? []
      : [
          {
            observationId,
            status: items.some((item) => item.status === "ok") ? "ok" : "unknown_listing",
            response: items.map((item) => item.response),
          } satisfies DeliveredSighting,
        ],
  );
}

function missing(clientRef: string): ListingStateAnswer {
  return { clientRef, status: "failed", response: null };
}

/**
 * Sends recorded unlisted sightings of the given channels to the product database (owner 2026-10-12: delistings go
 * with the marketplace sync). Live sightings stay stored: product sync already reports a listing on sale. Only a
 * final per-item answer is recorded; a failed item stays undelivered for a later send.
 */
export class ListingStateDelivery {
  constructor(
    private readonly deps: {
      store: ListingStateStore;
      sender: ListingStateSender;
      targets: ListingTargets;
      channels: readonly string[];
    },
  ) {}

  async deliverPending(
    startedAt: string,
    signal: AbortSignal,
  ): Promise<{ sent: number; held: number }> {
    const pending = await this.deps.store.undelivered({
      limit: BATCH_LIMIT,
      channels: this.deps.channels,
      state: "unlisted",
    });
    if (pending.length === 0) {
      return { sent: 0, held: 0 };
    }
    const targets = await this.deps.targets.externalIds(pending);
    let sent = 0;
    for (const { batch, owners } of listingStateBatches(pending, targets, startedAt)) {
      const delivered = deliveredSightings(await this.deps.sender.send(batch, signal), owners);
      await this.deps.store.markDelivered(delivered);
      sent += delivered.length;
    }
    return { sent, held: pending.length - sent };
  }
}
