import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import {
  AddToQueueSchema,
  PauseQueueSchema,
  QueueChannelSchema,
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

function fixture() {
  const channels = fakeStore();
  const amazonHistory = { migrationPreview: vi.fn(async () => ({ pending: 7, alreadyCopied: 2 })) };
  const service = new QueueService({ channels, amazonHistory, log: silent });
  return { service, channels, amazonHistory };
}

describe("QueueService", () => {
  it.each(QueueChannelSchema.options)(
    "routes every %s operation to the shared store",
    async (channel) => {
      const { service, channels, amazonHistory } = fixture();
      const query = QueueItemsQuerySchema.parse({ channel });
      const limits = { channel, ready: 4, running: 2 };
      const pause = PauseQueueSchema.parse({ channel });
      const requeue = { channel, itemIds: ["a".repeat(64)] };
      const list = AddToQueueSchema.parse({
        channel,
        batchId: "33333333-3333-4333-8333-333333333333",
        label: "scan",
        products: [product],
      });
      expect((await service.status(channel)).channel).toBe(channel);
      expect(await service.items(query)).toEqual([]);
      expect(await service.add(list)).toEqual({ added: 1 });
      await service.setLimits(limits);
      await service.pause(pause);
      await service.resume(channel);
      expect(await service.requeue(requeue)).toEqual({ requeued: 1 });
      expect(channels.status).toHaveBeenCalledTimes(4);
      expect(channels.status).toHaveBeenCalledWith(channel);
      expect(channels.items).toHaveBeenCalledWith(query);
      expect(channels.add).toHaveBeenCalledWith(list);
      expect(channels.setLimits).toHaveBeenCalledWith(limits);
      expect(channels.pause).toHaveBeenCalledWith(pause);
      expect(channels.resume).toHaveBeenCalledWith(channel);
      expect(channels.requeue).toHaveBeenCalledWith(requeue);
      expect(amazonHistory.migrationPreview).not.toHaveBeenCalled();
    },
  );

  it("returns a read-only migration preview without changing either queue", async () => {
    const { service, channels, amazonHistory } = fixture();
    expect(await service.amazonMigrationPreview()).toEqual({ pending: 7, alreadyCopied: 2 });
    expect(amazonHistory.migrationPreview).toHaveBeenCalledOnce();
    for (const method of Object.values(channels)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("preserves a refusal from the shared store without trying the legacy queue", async () => {
    const { service, channels } = fixture();
    const error = new Error("cleanup pending");
    vi.mocked(channels.resume).mockRejectedValueOnce(error);
    await expect(service.resume("amazon")).rejects.toBe(error);
    expect(channels.status).not.toHaveBeenCalled();
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

  it("accepts Amazon URL lists and refuses legacy batches or a page that is not HTTPS", () => {
    const batchId = "33333333-3333-4333-8333-333333333333";
    const amazonList = { channel: "amazon", batchId, label: "x", products: [product] };
    const plainHttp = {
      channel: "gnc",
      batchId,
      label: "x",
      products: [{ ...product, url: "http://www.gnc.com/x" }],
    };
    expect(AddToQueueSchema.safeParse(amazonList).success).toBe(true);
    expect(
      AddToQueueSchema.safeParse({ channel: "amazon", campaignId: "old", batches: [] }).success,
    ).toBe(false);
    expect(AddToQueueSchema.safeParse(plainHttp).success).toBe(false);
  });
});
