import { createLogger } from "@crawl-automation/platform";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DeliveryRunner } from "./delivery-runner.js";
import type { DeliveryScan, ScanCursor } from "./ports.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});
const cursor = (requestId: string): ScanCursor => ({
  createdAt: "2026-09-29T00:00:00.000000Z",
  requestId,
});

function scanOf(rows: ScanCursor[]): DeliveryScan {
  return {
    upperBound: vi.fn(async () => rows.at(-1) ?? null),
    page: vi.fn(async (after: ScanCursor | null) => (after ? [] : rows)),
  };
}

describe("DeliveryRunner", () => {
  it("reconciles every row of a sweep once", async () => {
    const scan = scanOf([cursor("a"), cursor("b"), cursor("c")]);
    const coordinator = { reconcile: vi.fn(async (_requestId: string) => undefined) };
    const runner = new DeliveryRunner(
      { scan, coordinator, isPaused: async () => false, log: silent },
      { batchSize: 10, concurrency: 2, intervalMs: 100 },
    );

    await runner.tick(new AbortController().signal);

    expect(coordinator.reconcile.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps going after one row fails", async () => {
    const scan = scanOf([cursor("a"), cursor("b")]);
    const coordinator = {
      reconcile: vi.fn(async (id: string) => {
        if (id === "a") {
          throw new Error("unavailable");
        }
      }),
    };
    const runner = new DeliveryRunner(
      { scan, coordinator, isPaused: async () => false, log: silent },
      { batchSize: 10, concurrency: 1, intervalMs: 100 },
    );

    await runner.tick(new AbortController().signal);

    expect(coordinator.reconcile).toHaveBeenCalledTimes(2);
  });

  it("does nothing while paused", async () => {
    const scan = scanOf([cursor("a")]);
    const coordinator = { reconcile: vi.fn(async (_requestId: string) => undefined) };
    const runner = new DeliveryRunner(
      { scan, coordinator, isPaused: async () => true, log: silent },
      { batchSize: 10, concurrency: 1, intervalMs: 100 },
    );

    await runner.tick(new AbortController().signal);

    expect(scan.upperBound).not.toHaveBeenCalled();
    expect(coordinator.reconcile).not.toHaveBeenCalled();
  });
});
