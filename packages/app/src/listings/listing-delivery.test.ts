import { describe, expect, it, vi } from "vitest";
import {
  ListingStateDelivery,
  deliveredSightings,
  listingStateBatches,
} from "./listing-delivery.js";
import type { ListingObservation } from "./listing-model.js";
import type { ListingStateAnswer, ListingStateBatch, ListingStateStore } from "./ports.js";

const startedAt = "2026-09-30T10:00:00.000Z";
const signal = new AbortController().signal;
function observation(changes: Partial<ListingObservation> = {}): ListingObservation {
  return {
    observationId: "observation",
    channel: "gnc",
    listingId: "listing",
    variantId: null,
    brandId: null,
    runId: null,
    state: "unlisted",
    reason: "not_found",
    source: "product-run",
    capturedAt: startedAt,
    registeredAt: startedAt,
    deliveredAt: null,
    evidence: {
      probe: "direct-revisit",
      causeCode: "LISTING.NOT_FOUND",
      httpStatus: 404,
      observedExternalId: null,
      finalUrl: null,
      artifactKey: "retained/page.html",
    },
    ...changes,
  };
}
const answered =
  (status: ListingStateAnswer["status"] = "ok") =>
  async (batch: ListingStateBatch): Promise<ListingStateAnswer[]> =>
    batch.items.map((item) => ({ clientRef: item.clientRef, status, response: { status } }));

function setup(pending: ListingObservation[] = [], targets = new Map<string, string[]>()) {
  const store = {
    record: vi.fn(),
    list: vi.fn(),
    counts: vi.fn(),
    undelivered: vi.fn(async () => pending),
    markDelivered: vi.fn(async () => undefined),
  } satisfies ListingStateStore;
  const sender = { send: vi.fn(answered()) };
  const lookup = { externalIds: vi.fn(async () => targets) };
  const delivery = new ListingStateDelivery({
    store,
    sender,
    targets: lookup,
    channels: ["gnc", "costco"],
  });
  return { store, sender, lookup, delivery };
}

describe("ListingStateDelivery.deliverPending", () => {
  it("asks for at most 200 unlisted sightings of its channels and sends nothing for an empty queue", async () => {
    const { delivery, store, sender, lookup } = setup();
    expect(await delivery.deliverPending(startedAt, signal)).toEqual({ sent: 0, held: 0 });
    expect(store.undelivered).toHaveBeenCalledExactlyOnceWith({
      limit: 200,
      channels: ["gnc", "costco"],
      state: "unlisted",
    });
    expect(lookup.externalIds).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("marks a sighting delivered only when every one of its IDs has a final answer", async () => {
    const fake = setup(
      [observation({ channel: "costco" }), observation({ observationId: "other" })],
      new Map([["observation", ["v1", "v2"]]]),
    );
    fake.sender.send.mockImplementation(async (batch) =>
      batch.items.map((item) => ({
        clientRef: item.clientRef,
        status: item.listing.externalId === "v2" ? ("unknown_listing" as const) : ("ok" as const),
        response: item.listing.externalId,
      })),
    );
    expect(await fake.delivery.deliverPending(startedAt, signal)).toEqual({ sent: 2, held: 0 });
    expect(fake.store.markDelivered).toHaveBeenCalledWith([
      { observationId: "observation", status: "ok", response: ["v1", "v2"] },
    ]);
  });

  it("holds a sighting whose item failed or was not answered", async () => {
    const fake = setup([observation()]);
    fake.sender.send.mockImplementation(answered("failed"));
    expect(await fake.delivery.deliverPending(startedAt, signal)).toEqual({ sent: 0, held: 1 });
    expect(fake.store.markDelivered).toHaveBeenCalledWith([]);
  });

  it.each(["undelivered", "send", "markDelivered"] as const)(
    "propagates %s failures without retrying",
    async (method) => {
      const fake = setup([observation()]);
      const failure = new Error("delivery dependency failed");
      const failing = method === "send" ? fake.sender.send : fake.store[method];
      failing.mockRejectedValue(failure);
      await expect(fake.delivery.deliverPending(startedAt, signal)).rejects.toBe(failure);
      expect(failing).toHaveBeenCalledOnce();
      if (method !== "markDelivered") {
        expect(fake.store.markDelivered).not.toHaveBeenCalled();
      }
    },
  );
});

describe("listingStateBatches", () => {
  it("groups channels in first-seen order, one item per synced ID, without a null artifact key", () => {
    const first = observation({ evidence: { ...observation().evidence, artifactKey: null } });
    const planned = listingStateBatches(
      [
        first,
        observation({ channel: "costco", observationId: "c" }),
        observation({ observationId: "v", variantId: "large" }),
      ],
      new Map([["c", ["111", "222"]]]),
      startedAt,
    );
    expect(planned.map(({ batch }) => [batch.run.channel, batch.items.length])).toEqual([
      ["gnc", 2],
      ["costco", 2],
    ]);
    expect(planned[0]?.batch.run).toEqual({
      runId: `listing-state-${startedAt}-gnc`,
      channel: "gnc",
      scope: "partial",
      source: "crawler-v3:listing-state",
      startedAt,
    });
    const { artifactKey: _key, ...evidence } = first.evidence;
    expect(planned[0]?.batch.items[0]).toEqual({
      clientRef: `gnc:listing:${startedAt}`,
      listing: { channel: "gnc", externalId: "listing" },
      capturedAt: startedAt,
      state: "gone",
      source: first.source,
      evidence: { ...evidence, reason: "not_found", observationId: first.observationId },
    });
    expect(planned[0]?.batch.items[1]?.listing.externalId).toBe("large");
    expect(planned[1]?.batch.items.map((item) => item.listing.externalId)).toEqual(["111", "222"]);
    expect([...(planned[1]?.owners.values() ?? [])]).toEqual(["c", "c"]);
  });

  it("keeps a sighting's items in one request of at most 200", () => {
    const many = Array.from({ length: 150 }, (_, index) => String(index));
    const planned = listingStateBatches(
      [observation({ observationId: "a" }), observation({ observationId: "b" })],
      new Map([
        ["a", many],
        ["b", many.map((id) => `b-${id}`)],
      ]),
      startedAt,
    );
    expect(planned.map(({ batch }) => [batch.run.runId, batch.items.length])).toEqual([
      [`listing-state-${startedAt}-gnc`, 150],
      [`listing-state-${startedAt}-gnc-2`, 150],
    ]);
  });

  it.each([
    "not_found",
    "redirected_to_other_product",
    "redirected_away",
    "identity_conflict",
  ] as const)("keeps %s as evidence while sending gone", (reason) => {
    const sighting = observation({ reason });
    expect(listingStateBatches([sighting], new Map(), startedAt)[0]?.batch.items[0]).toMatchObject({
      state: "gone",
      evidence: { reason },
    });
  });
});

describe("deliveredSightings", () => {
  it("treats a missing answer as not final", () => {
    expect(deliveredSightings([], new Map([["ref", "observation"]]))).toEqual([]);
  });
});
