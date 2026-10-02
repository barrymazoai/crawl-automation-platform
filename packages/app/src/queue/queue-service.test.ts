import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import {
  AddToQueueSchema,
  PauseQueueSchema,
  QueueChannelSchema,
  QueueItemsQuerySchema,
  RequeueSchema,
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
    summary: vi.fn(async () => []),
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
    "opts only %s discoveries into the default window",
    async (channel) => {
      const { service, channels } = fixture();
      const input = AddToQueueSchema.parse({
        channel,
        batchId: "33333333-3333-4333-8333-333333333333",
        label: "scan",
        products: [product],
      });
      vi.mocked(channels.add).mockResolvedValueOnce({ added: 1, following: 2, recent: 3 });
      expect(await service.addScanDiscovery(input)).toEqual({ added: 1, following: 2, recent: 3 });
      expect(channels.add).toHaveBeenLastCalledWith(input, { recentScanSkipHours: 24 });
      await service.add(input);
      expect(channels.add).toHaveBeenLastCalledWith(input);
    },
  );

  it.each([0, 48])("passes the configured %i-hour window", async (recentScanSkipHours) => {
    const channels = fakeStore();
    const service = new QueueService({
      channels,
      amazonHistory: fixture().amazonHistory,
      log: silent,
      scanAdmission: { recentScanSkipHours },
    });
    const input = AddToQueueSchema.parse({
      channel: "wholefoods",
      batchId: "33333333-3333-4333-8333-333333333333",
      label: "scan",
      products: [product],
    });
    expect(await service.addScanDiscovery(input)).toEqual({ added: 1, following: 0, recent: 0 });
    expect(channels.add).toHaveBeenCalledExactlyOnceWith(input, { recentScanSkipHours });
  });

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
      expect(await service.summary({ channel })).toEqual([]);
      expect(await service.add(list)).toEqual({ added: 1 });
      await service.setLimits(limits);
      await service.pause(pause);
      await service.resume(channel);
      expect(await service.requeue(requeue)).toEqual({ requeued: 1 });
      expect(channels.status).toHaveBeenCalledTimes(4);
      expect(channels.status).toHaveBeenCalledWith(channel);
      expect(channels.items).toHaveBeenCalledWith(query);
      expect(channels.summary).toHaveBeenCalledWith({ channel });
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

  it("passes all item filters and exact scan request summaries to the shared store", async () => {
    const { service, channels } = fixture();
    const filters = {
      channel: "amazon" as const,
      state: "review" as const,
      limit: 25,
      reasons: ["QUEUE.RUN_FAILED"],
      updatedSince: "2026-10-01T00:00:00Z",
      createdSince: "2026-09-30T00:00:00Z",
      sourceIds: [product.sourceId],
      listingIds: ["B001"],
    };
    await service.items(filters);
    expect(channels.items).toHaveBeenCalledExactlyOnceWith(filters);
    const summary = {
      channel: filters.channel,
      sourceIds: filters.sourceIds,
      createdSince: filters.createdSince,
      requestId: "33333333-3333-4333-8333-333333333333",
    };
    await service.summary(summary);
    expect(channels.summary).toHaveBeenCalledExactlyOnceWith(summary);
  });

  it("previews by default and delegates explicit filter execution once without resuming intake", async () => {
    const { service, channels } = fixture();
    const input = RequeueSchema.parse({ channel: "amazon", filter: { state: "review" }, limit: 7 });
    const preview = { dryRun: true as const, count: 4, sample: [] };
    vi.mocked(channels.requeue).mockResolvedValueOnce(preview);
    expect(await service.requeue(input)).toEqual(preview);
    expect(channels.requeue).toHaveBeenCalledExactlyOnceWith({ ...input, dryRun: true });
    const execute = { ...input, dryRun: false };
    expect(await service.requeue(execute)).toEqual({ requeued: 1 });
    expect(channels.requeue).toHaveBeenLastCalledWith(execute);
    expect(channels.resume).not.toHaveBeenCalled();
    expect(channels.add).not.toHaveBeenCalled();
  });

  it("does not retry a failed filter requeue", async () => {
    const { service, channels } = fixture();
    const failure = new Error("transaction failed");
    vi.mocked(channels.requeue).mockRejectedValueOnce(failure);
    const input = RequeueSchema.parse({ filter: { state: "review" }, limit: 1, dryRun: false });
    await expect(service.requeue(input)).rejects.toBe(failure);
    expect(channels.requeue).toHaveBeenCalledOnce();
  });

  it("preserves a refusal from the shared store without trying the legacy queue", async () => {
    const { service, channels } = fixture();
    const error = new Error("cleanup pending");
    vi.mocked(channels.resume).mockRejectedValueOnce(error);
    await expect(service.resume("amazon")).rejects.toBe(error);
    expect(channels.status).not.toHaveBeenCalled();
  });

  it("reads and reconciles family outcomes without requeueing Whole Foods", async () => {
    const { channels, service } = fixture();
    channels.familyOutcomes = vi.fn(async () => []);
    channels.recordFamilyOutcome = vi.fn(async () => undefined);
    channels.findFamilyFormula = vi.fn(async () => null);
    const query = { operationIds: ["wf-capture"] };
    expect(await service.familyOutcomes(query)).toEqual([]);
    expect(await service.reconcileFamilyOutcomes(query)).toEqual([]);
    expect(channels.familyOutcomes).toHaveBeenCalledWith(query);
    expect(channels.familyOutcomes).toHaveBeenCalledTimes(3);
    expect(channels.add).not.toHaveBeenCalled();
    expect(channels.requeue).not.toHaveBeenCalled();
  });

  it("refuses missing outcome storage explicitly", async () => {
    const { service } = fixture();
    expect(() => service.familyOutcomes({ operationIds: ["wf"] })).toThrow(
      expect.objectContaining({ code: "QUEUE.NOT_CONFIGURED" }),
    );
    await expect(service.reconcileFamilyOutcomes({ operationIds: ["wf"] })).rejects.toMatchObject({
      code: "QUEUE.NOT_CONFIGURED",
    });
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
