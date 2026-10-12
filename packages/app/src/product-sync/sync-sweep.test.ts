import { createLogger } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import type { ProductSyncResult } from "./sync-model.js";
import { ProductSyncSweep } from "./sync-sweep.js";

const signal = new AbortController().signal;
const log = createLogger({ name: "product-sync", destination: { write: () => undefined } });
const result = {
  read: 0,
  toSend: 0,
  verified: 0,
  needsReview: 0,
  failed: [],
} as unknown as ProductSyncResult;

function setup() {
  const order: string[] = [];
  const sync = vi.fn(async (request: { channel: string }) => {
    order.push(request.channel);
    return result;
  });
  const deliverPending = vi.fn(async () => {
    order.push("delistings");
    return { sent: 1, held: 0 };
  });
  const sweep = new ProductSyncSweep({
    sync: { sync },
    listings: { deliverPending },
    settings: { channels: ["gnc", "amazon"], batchLimit: 5, maxBatchesPerChannel: 1 },
    log,
    now: () => new Date("2026-10-12T10:00:00.000Z"),
  });
  return { sweep, sync, deliverPending, order };
}

it("sends the round's delistings after every channel's products", async () => {
  const fake = setup();
  await fake.sweep.sweep(signal);
  expect(fake.order).toEqual(["gnc", "amazon", "delistings"]);
  expect(fake.deliverPending).toHaveBeenCalledWith("2026-10-12T10:00:00.000Z", signal);
});

it("a delisting failure is logged and never fails the round", async () => {
  const fake = setup();
  fake.deliverPending.mockRejectedValue(new Error("Supply Smart down"));
  await expect(fake.sweep.sweep(signal)).resolves.toHaveLength(2);
});
