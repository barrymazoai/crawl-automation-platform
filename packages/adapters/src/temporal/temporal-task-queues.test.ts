import type { Client } from "@temporalio/client";
import { msNumberToTs } from "@temporalio/common/lib/time.js";
import { describe, expect, it, vi } from "vitest";
import { TemporalTaskQueues } from "./temporal-task-queues.js";

function fixture() {
  const describeTaskQueue = vi.fn().mockResolvedValue({ pollers: [] });
  const withDeadline = vi.fn(async (_deadline: number, call: () => Promise<unknown>) => call());
  const client = {
    options: { namespace: "crawler-test" },
    connection: { withDeadline },
    workflowService: { describeTaskQueue },
  } as unknown as Client;
  return { source: new TemporalTaskQueues(client), describeTaskQueue, withDeadline };
}

describe("Temporal task queue descriptions", () => {
  it.each([
    ["workflow", 1],
    ["activity", 2],
  ] as const)(
    "uses the existing client namespace and describes %s pollers",
    async (kind, value) => {
      const fake = fixture();
      const before = Date.now();
      const result = await fake.source.describe("browser", kind);
      expect(result).toEqual([]);
      expect(fake.describeTaskQueue).toHaveBeenCalledWith({
        namespace: "crawler-test",
        taskQueue: { name: "browser", kind: 1 },
        taskQueueType: value,
      });
      expect(fake.withDeadline.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(before + 5_000);
      expect(fake.withDeadline.mock.calls[0]?.[0]).toBeLessThanOrEqual(Date.now() + 5_000);
    },
  );

  it("preserves cross-machine identities and converts protobuf timestamps", async () => {
    const fake = fixture();
    const lastAccess = "2026-09-30T10:00:00.123Z";
    fake.describeTaskQueue.mockResolvedValue({
      pollers: [
        {
          identity: "123@server-two",
          lastAccessTime: msNumberToTs(Date.parse(lastAccess)),
          ratePerSecond: 50,
        },
        { identity: "456@server-one" },
      ],
    });
    expect(await fake.source.describe("browser", "activity")).toEqual([
      { identity: "123@server-two", lastAccessTime: lastAccess, ratePerSecond: 50 },
      { identity: "456@server-one", lastAccessTime: null, ratePerSecond: null },
    ]);
  });

  it("handles an omitted poller list", async () => {
    const fake = fixture();
    fake.describeTaskQueue.mockResolvedValue({});
    expect(await fake.source.describe("empty", "workflow")).toEqual([]);
  });

  it("propagates the actual RPC error without retrying or closing the shared client", async () => {
    const fake = fixture();
    const error = Object.assign(new Error("unavailable"), { code: 14 });
    fake.describeTaskQueue.mockRejectedValue(error);
    await expect(fake.source.describe("browser", "activity")).rejects.toBe(error);
    expect(fake.describeTaskQueue).toHaveBeenCalledOnce();
  });
});
