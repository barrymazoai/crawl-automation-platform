import { describe, expect, it, vi } from "vitest";
import { ListingStateDelivery, listingStateBatches } from "./listing-delivery.js";
import type { ListingObservation } from "./listing-model.js";
import type { DeliveredSighting, ListingStateStore } from "./ports.js";

const startedAt = "2026-09-30T10:00:00.000Z";
function observation(changes: Partial<ListingObservation> = {}): ListingObservation {
  return {
    observationId: "observation",
    channel: "gnc",
    listingId: "listing",
    variantId: null,
    brandId: null,
    runId: null,
    state: "live",
    reason: null,
    source: "product-run",
    capturedAt: startedAt,
    registeredAt: startedAt,
    deliveredAt: null,
    evidence: {
      probe: "direct-revisit",
      causeCode: "LISTING.LIVE",
      httpStatus: 200,
      observedExternalId: null,
      finalUrl: null,
      artifactKey: "retained/page.html",
    },
    ...changes,
  };
}

function setup(pending: ListingObservation[] = []) {
  const store = {
    record: vi.fn(),
    list: vi.fn(),
    counts: vi.fn(),
    undelivered: vi.fn(async () => pending),
    markDelivered: vi.fn(async () => undefined),
  } satisfies ListingStateStore;
  const sender = { send: vi.fn(async (): Promise<DeliveredSighting[]> => []) };
  return { store, sender, delivery: new ListingStateDelivery({ store, sender }) };
}

describe("ListingStateDelivery.deliverPending", () => {
  it("asks for at most 200 sightings and sends nothing for an empty queue", async () => {
    const { delivery, store, sender } = setup();
    expect(await delivery.deliverPending(startedAt)).toEqual({ sent: 0, held: 0 });
    expect(store.undelivered).toHaveBeenCalledExactlyOnceWith(200);
    expect(sender.send).not.toHaveBeenCalled();
    expect(store.markDelivered).not.toHaveBeenCalled();
  });

  it("records partial and unknown-listing final answers while holding unanswered sightings", async () => {
    const fake = setup([observation(), observation({ observationId: "other" })]);
    const answers: DeliveredSighting[] = [
      { observationId: "observation", status: "unknown_listing", response: { missing: true } },
    ];
    fake.sender.send.mockResolvedValue(answers);
    expect(await fake.delivery.deliverPending(startedAt)).toEqual({ sent: 1, held: 1 });
    expect(fake.store.markDelivered).toHaveBeenCalledExactlyOnceWith(answers);
    expect(fake.sender.send.mock.invocationCallOrder[0]).toBeLessThan(
      fake.store.markDelivered.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps all sightings held when a sender returns no final answers", async () => {
    const fake = setup([observation()]);
    expect(await fake.delivery.deliverPending(startedAt)).toEqual({ sent: 0, held: 1 });
    expect(fake.store.markDelivered).toHaveBeenCalledWith([]);
  });

  it.each(["undelivered", "send", "markDelivered"] as const)(
    "propagates %s failures without retrying",
    async (method) => {
      const fake = setup([observation()]);
      const failure = new Error("delivery dependency failed");
      const failing = method === "send" ? fake.sender.send : fake.store[method];
      failing.mockRejectedValue(failure);
      await expect(fake.delivery.deliverPending(startedAt)).rejects.toBe(failure);
      expect(failing).toHaveBeenCalledOnce();
      if (method !== "markDelivered") {
        expect(fake.store.markDelivered).not.toHaveBeenCalled();
      }
      if (method === "undelivered") {
        expect(fake.sender.send).not.toHaveBeenCalled();
      }
    },
  );

  it("retains the first channel's acknowledgement if sending a later channel fails", async () => {
    const fake = setup([
      observation(),
      observation({ channel: "swanson", observationId: "other" }),
    ]);
    const failure = new Error("second channel failed");
    const accepted: DeliveredSighting[] = [
      { observationId: "observation", status: "ok", response: {} },
    ];
    fake.sender.send.mockResolvedValueOnce(accepted).mockRejectedValueOnce(failure);
    await expect(fake.delivery.deliverPending(startedAt)).rejects.toBe(failure);
    expect(fake.store.markDelivered).toHaveBeenCalledExactlyOnceWith(accepted);
  });
});

describe("listingStateBatches", () => {
  it("groups interleaved channels in first-seen order and preserves live variant evidence", () => {
    const first = observation({ variantId: "large" });
    const batches = listingStateBatches(
      [first, observation({ channel: "swanson" }), observation()],
      startedAt,
    );
    expect(batches.map((batch) => [batch.run.channel, batch.items.length])).toEqual([
      ["gnc", 2],
      ["swanson", 1],
    ]);
    expect(batches[0]?.run).toEqual({
      runId: `listing-state-${startedAt}-gnc`,
      channel: "gnc",
      scope: "partial",
      source: "crawler-v3:listing-state",
      startedAt,
    });
    expect(batches[0]?.items[0]).toEqual({
      clientRef: `gnc:listing:large:${startedAt}`,
      listing: { channel: "gnc", externalId: "listing", variantId: "large" },
      capturedAt: startedAt,
      state: "live",
      source: first.source,
      evidence: { ...first.evidence, reason: null, observationId: first.observationId },
    });
    expect(batches[0]?.items[1]?.clientRef).toBe(`gnc:listing:-:${startedAt}`);
  });

  it.each([
    "not_found",
    "redirected_to_other_product",
    "redirected_away",
    "identity_conflict",
  ] as const)("keeps %s as evidence while sending gone", (reason) => {
    const sighting = observation({ state: "unlisted", reason });
    expect(listingStateBatches([sighting], startedAt)[0]?.items[0]).toMatchObject({
      state: "gone",
      evidence: { reason },
    });
  });
});
