import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import {
  AddToQueueSchema,
  PauseQueueSchema,
  QueueItemsQuerySchema,
  type QueueChannel,
  type QueueStore,
} from "./queue-model.js";
import { QueueService } from "./queue-service.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_chunk, _encoding, done) => done() }),
});

function fakeStore(): QueueStore {
  return {
    status: vi.fn(async (channel: QueueChannel) => ({
      channel,
      mode: "paused" as const,
      readyLimit: 20,
      runningLimit: 40,
      counts: {},
      attention: 0,
    })),
    items: vi.fn(async () => []),
    add: vi.fn(async () => ({ added: 1 })),
    setLimits: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    requeue: vi.fn(async () => ({ requeued: 1 })),
  };
}

const product = {
  sourceId: "22222222-2222-4222-8222-222222222222",
  url: "https://www.gnc.com/whey-protein/350123.html",
  listingId: "350123",
};

describe("QueueService", () => {
  it("routes Amazon to its existing tables and every other channel to the shared queue", async () => {
    const amazon = fakeStore();
    const channels = fakeStore();
    const service = new QueueService({ amazon, channels, log: silent });
    await service.status("amazon");
    await service.status("gnc");
    await service.pause(PauseQueueSchema.parse({ channel: "swanson" }));
    expect(amazon.status).toHaveBeenCalledWith("amazon");
    expect(channels.status).toHaveBeenCalledWith("gnc");
    expect(channels.pause).toHaveBeenCalledWith({
      channel: "swanson",
      force: false,
      graceSeconds: 900,
    });
    expect(amazon.pause).not.toHaveBeenCalled();
  });

  it("adds another channel's product list to the shared queue", async () => {
    const amazon = fakeStore();
    const channels = fakeStore();
    const service = new QueueService({ amazon, channels, log: silent });
    const list = AddToQueueSchema.parse({
      channel: "gnc",
      batchId: "33333333-3333-4333-8333-333333333333",
      label: "GNC Optimum Nutrition scan",
      products: [product],
    });
    expect(await service.add(list)).toEqual({ added: 1 });
    expect(channels.add).toHaveBeenCalledWith({
      ...list,
      products: [{ ...product, variantId: null }],
    });
    expect(amazon.add).not.toHaveBeenCalled();
  });
});

describe("queue inputs", () => {
  it("a call without a channel is about Amazon's queue", () => {
    expect(QueueItemsQuerySchema.parse({})).toEqual({
      channel: "amazon",
      state: "running",
      limit: 200,
    });
  });

  it("refuses a product list for Amazon's queue and a page that is not HTTPS", () => {
    const batchId = "33333333-3333-4333-8333-333333333333";
    const amazonList = { channel: "amazon", batchId, label: "x", products: [product] };
    const plainHttp = {
      channel: "gnc",
      batchId,
      label: "x",
      products: [{ ...product, url: "http://www.gnc.com/x" }],
    };
    expect(AddToQueueSchema.safeParse(amazonList).success).toBe(false);
    expect(AddToQueueSchema.safeParse(plainHttp).success).toBe(false);
  });
});
