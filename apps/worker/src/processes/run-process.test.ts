import { createLogger } from "@crawl-automation/platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerParts } from "../container.js";
import { runProcess } from "./run-process.js";
import type { WorkerRole } from "./process-config.js";

const { runWorkers } = vi.hoisted(() => ({ runWorkers: vi.fn() }));
vi.mock("@crawl-automation/platform/temporal-worker", () => ({ runWorkers }));
vi.mock("./role-workers.js", () => ({ roleWorkers: vi.fn(() => []) }));

beforeEach(() => vi.stubEnv("V3_WORKER_HEALTH_FILE", ""));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function pendingStop() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(role: WorkerRole = "resources") {
  const stopped = pendingStop();
  const worker = { done: stopped.promise, shutdown: vi.fn(() => stopped.resolve()) };
  runWorkers.mockResolvedValue(worker);
  const signals: AbortSignal[] = [];
  const run = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const parts = {
    config: { temporal: {} },
    log: createLogger({ name: "process-test", level: "error" }),
    resourceHealth: { run },
  } as unknown as WorkerParts;
  const chosen = {
    name: "test",
    roles: [{ role, taskQueue: "queue", maxConcurrentActivities: 1 }],
  };
  return { stopped, worker, signals, run, parts, start: () => runProcess(chosen, parts) };
}

describe("worker-owned resource health lifecycle", () => {
  it("does not access the monitor in a process without the resources role", async () => {
    const test = fixture("pipeline");
    const running = test.start();
    test.stopped.resolve();
    await running;
    expect(test.run).not.toHaveBeenCalled();
  });

  it("stops and joins the monitor when workers finish without a signal", async () => {
    const test = fixture();
    const cleanup = pendingStop();
    test.run.mockImplementation(async (signal) => {
      test.signals.push(signal);
      await cleanup.promise;
    });
    const running = test.start();
    let finished = false;
    void running.then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(test.run).toHaveBeenCalledOnce());
    test.stopped.resolve();
    await vi.waitFor(() => expect(test.signals[0]?.aborted).toBe(true));
    expect(finished).toBe(false);
    cleanup.resolve();
    await running;
    expect(finished).toBe(true);
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "aborts on %s and removes only its signal handlers",
    async (event) => {
      const before = process.listeners(event);
      const test = fixture();
      const running = test.start();
      await vi.waitFor(() => expect(test.run).toHaveBeenCalledOnce());
      const own = process.listeners(event).find((handler) => !before.includes(handler));
      expect(own).toBeDefined();
      own?.(event);
      await running;
      expect(test.signals[0]?.aborted).toBe(true);
      expect(test.worker.shutdown).toHaveBeenCalled();
      expect(process.listeners(event)).toEqual(before);
    },
  );

  it("aborts monitoring and preserves a fatal worker error", async () => {
    const test = fixture();
    const running = test.start();
    const result = expect(running).rejects.toThrow("worker failed");
    await vi.waitFor(() => expect(test.run).toHaveBeenCalledOnce());
    test.stopped.reject(new Error("worker failed"));
    await result;
    expect(test.signals[0]?.aborted).toBe(true);
  });

  it("stops the worker if monitoring cannot start", async () => {
    const test = fixture();
    test.run.mockRejectedValue(new Error("monitor connection failed"));
    await expect(test.start()).rejects.toThrow("monitor connection failed");
    expect(test.worker.shutdown).toHaveBeenCalled();
  });

  it("keeps the worker running when the optional monitor is unconfigured", async () => {
    const test = fixture();
    test.run.mockResolvedValue(undefined);
    const running = test.start();
    await vi.waitFor(() => expect(test.run).toHaveBeenCalledOnce());
    expect(test.worker.shutdown).not.toHaveBeenCalled();
    test.stopped.resolve();
    await running;
  });
});
