import { describe, expect, it, vi } from "vitest";
import { ListingStateDelivery, listingStateBatches } from "./listing-delivery.js";
import type { ListingObservation } from "./listing-model.js";
import { ListingStateService } from "./listing-state-service.js";
import type { DeliveredSighting, ListingStateStore, NewListingObservation } from "./ports.js";

const brandId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const sourceId = "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** An in-memory `listing_state_observation`: first record kept, delivery marks kept apart. */
class MemoryListingStates implements ListingStateStore {
  readonly rows = new Map<string, ListingObservation>();
  readonly delivered: DeliveredSighting[] = [];

  async record(observation: NewListingObservation) {
    const saved = this.rows.get(observation.observationId) ?? {
      ...observation,
      registeredAt: observation.capturedAt,
      deliveredAt: null,
    };
    this.rows.set(observation.observationId, saved);
    return saved;
  }
  list = vi.fn(async () => [...this.rows.values()]);
  counts = vi.fn(async () => ({
    channel: "swanson",
    byState: { gone: 0, superseded: 0, live: 0 },
    undelivered: 0,
  }));
  async undelivered() {
    const done = new Set(this.delivered.map((result) => result.observationId));
    return [...this.rows.values()].filter((row) => !done.has(row.observationId));
  }
  async markDelivered(results: DeliveredSighting[]) {
    this.delivered.push(...results);
  }
}

function sighting(changes: Record<string, unknown> = {}) {
  return {
    channel: "swanson",
    listingId: "old-handle",
    variantId: null,
    brandId,
    runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
    state: "gone",
    evidence: {
      probe: "direct-revisit",
      causeCode: "CAPTURE.NOT_FOUND",
      httpStatus: 404,
      observedExternalId: null,
      artifactKey: null,
    },
    source: "crawler-v3:product-run:pipeline-1",
    capturedAt: "2026-09-29T10:00:00.000Z",
    ...changes,
  };
}

function setup() {
  const store = new MemoryListingStates();
  const queue = { add: vi.fn(async () => ({ added: 1 })) };
  return { store, queue, service: new ListingStateService({ store, queue }) };
}

describe("ListingStateService", () => {
  it("records a sighting once per listing and source, even when recorded again later", async () => {
    const { store, service } = setup();
    const first = await service.record(sighting());
    const again = await service.record(sighting({ capturedAt: "2026-09-29T11:00:00.000Z" }));
    expect(again.observationId).toBe(first.observationId);
    expect(store.rows.size).toBe(1);
    const other = await service.record(sighting({ source: "crawler-v3:product-run:pipeline-2" }));
    expect(other.observationId).not.toBe(first.observationId);
  });

  it("refuses a superseded listing that does not name the listing it became", async () => {
    const { store, service } = setup();
    await expect(service.record(sighting({ state: "superseded" }))).rejects.toMatchObject({
      code: "LISTING.OBSERVED_ID_MISSING",
    });
    expect(store.rows.size).toBe(0);
  });

  it("refuses a state that is not a listing state", async () => {
    const { service } = setup();
    await expect(service.record(sighting({ state: "delisted" }))).rejects.toThrow();
  });

  it("queues a direct revisit for listings a full scan no longer showed, and never records absence", async () => {
    const { store, queue, service } = setup();
    const listing = {
      sourceId,
      url: "https://www.gnc.com/product/877080.html",
      listingId: "877080",
    };
    const batchId = "33333333-3333-4333-8333-333333333333";
    const missing = {
      channel: "gnc",
      scope: "full",
      batchId,
      label: "GNC scan",
      listings: [listing],
    };

    expect(await service.requestRevisits(missing)).toEqual({ queued: 1 });
    expect(queue.add).toHaveBeenCalledWith({
      channel: "gnc",
      batchId,
      label: "GNC scan",
      products: [{ ...listing, variantId: null }],
    });
    expect(store.rows.size).toBe(0);
    await expect(service.requestRevisits({ ...missing, scope: "partial" })).rejects.toThrow();
  });
});

describe("listing state delivery", () => {
  it("holds every sighting while no product database sender is configured", async () => {
    const { store, service } = setup();
    await service.record(sighting());
    const delivery = new ListingStateDelivery({ store, sender: null });
    expect(await delivery.deliverPending("2026-09-29T12:00:00.000Z")).toEqual({ sent: 0, held: 1 });
    expect(store.delivered).toHaveLength(0);
  });

  it("sends one batch per channel in the product database's shape and records its answers", async () => {
    const { store, service } = setup();
    const gone = await service.record(sighting());
    await service.record(
      sighting({ channel: "gnc", listingId: "877080", source: "crawler-v3:product-run:gnc-1" }),
    );
    const send = vi.fn(async (batch: { items: Array<{ evidence: { observationId: string } }> }) =>
      batch.items.map((item) => ({
        observationId: item.evidence.observationId,
        status: "ok" as const,
        response: {},
      })),
    );
    const delivery = new ListingStateDelivery({ store, sender: { send } });
    expect(await delivery.deliverPending("2026-09-29T12:00:00.000Z")).toEqual({ sent: 2, held: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    const [batch] = listingStateBatches([gone], "2026-09-29T12:00:00.000Z");
    expect(batch?.run).toMatchObject({ channel: "swanson", scope: "partial" });
    expect(batch?.items[0]).toMatchObject({
      listing: { channel: "swanson", externalId: "old-handle" },
      state: "gone",
      evidence: { httpStatus: 404, observationId: gone.observationId },
    });
  });
});
