import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reserve: vi.fn(),
  release: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
  protected: 0,
  now: 0,
}));

vi.mock("@temporalio/workflow", () => ({
  ApplicationFailure: class extends Error {
    constructor(
      message: string,
      readonly type: string,
      readonly details: unknown[],
    ) {
      super(message);
    }
    static nonRetryable(message: string, type: string, ...details: unknown[]) {
      return new this(message, type, details);
    }
  },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
  CancellationScope: {
    nonCancellable: async (run: () => Promise<unknown>) => {
      state.protected++;
      try {
        return await run();
      } finally {
        state.protected--;
      }
    },
  },
  workflowInfo: () => ({
    runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
    workflowId: "gate-unit",
  }),
  proxyActivities: (options: Record<string, unknown>) => {
    state.options.push(options);
    return { reserveResources: state.reserve, releaseResources: state.release };
  },
  sleep: async (milliseconds: number) => {
    state.now += milliseconds;
  },
}));

import { resourceGate } from "./resource-gate.js";

const config = {
  queue: "resources",
  maxWaitSeconds: 10,
  activities: { work: [{ resourceId: "model", units: 1 }] },
};

beforeEach(() => {
  state.reserve.mockReset();
  state.release.mockReset();
  state.options = [];
  state.protected = 0;
  state.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => state.now);
  state.reserve.mockImplementation(async ({ permitId }: { permitId: string }) => {
    expect(state.protected).toBeGreaterThan(0);
    return { permitId, status: "granted", reason: "available" };
  });
  state.release.mockImplementation(async ({ permitId }: { permitId: string }) => {
    expect(state.protected).toBeGreaterThan(0);
    return { permitId, status: "released", reason: "released" };
  });
});

afterEach(() => vi.restoreAllMocks());

it("releases completion and supplies cancellation acknowledgement and heartbeats", async () => {
  const work = vi.fn(async () => "done");
  expect(await resourceGate(config)("work", work)).toBe("done");
  expect(work).toHaveBeenCalledWith(
    expect.objectContaining({
      cancellationType: "WAIT",
      heartbeatTimeout: "30 seconds",
    }),
  );
  expect(state.release).toHaveBeenCalledWith(state.reserve.mock.calls[0]?.[0]);
  expect(state.options.map((options) => options.retry)).toMatchObject([
    { maximumAttempts: 1 },
    { maximumAttempts: 3 },
  ]);
});

it.each(["failure", "cancellation", "timeout"])(
  "releases after %s and preserves the error",
  async (name) => {
    const failure = new Error(name);
    await expect(
      resourceGate(config)("work", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(state.release).toHaveBeenCalledOnce();
  },
);

it.each(["capacity", "unhealthy"])(
  "records %s wait expiry without running or releasing",
  async (reason) => {
    state.reserve.mockImplementation(async ({ permitId }: { permitId: string }) => ({
      permitId,
      status: "waiting",
      reason,
    }));
    const work = vi.fn();
    await expect(resourceGate(config)("work", work)).rejects.toMatchObject({
      type: "RESOURCE.WAIT_LIMIT",
      details: [expect.objectContaining({ reason, executionFact: "not_executed" })],
    });
    expect(work).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  },
);

it("rejects a mismatched reserve identity before work", async () => {
  state.reserve.mockResolvedValue({
    permitId: "wrong-permit",
    status: "granted",
    reason: "available",
  });
  const work = vi.fn();
  await expect(resourceGate(config)("work", work)).rejects.toMatchObject({
    type: "RESOURCE.IDENTITY_CONFLICT",
  });
  expect(work).not.toHaveBeenCalled();
});

it("surfaces an unverified release instead of claiming success", async () => {
  state.release.mockResolvedValue({
    permitId: "wrong-permit",
    status: "released",
    reason: "released",
  });
  await expect(resourceGate(config)("work", async () => "done")).rejects.toMatchObject({
    type: "RESOURCE.RELEASE_UNKNOWN",
  });
});

it("gives concurrent calls distinct permit IDs", async () => {
  const gate = resourceGate(config);
  await Promise.all([gate("work", async () => 1), gate("work", async () => 2)]);
  const requests = state.reserve.mock.calls.map(([request]) => request.permitId);
  expect(new Set(requests).size).toBe(2);
  expect(state.release.mock.calls.map(([request]) => request.permitId).sort()).toEqual(
    requests.sort(),
  );
});

it("ungated work does not touch the permit ledger", async () => {
  expect(await resourceGate(undefined)("work", async () => "done")).toBe("done");
  expect(state.reserve).not.toHaveBeenCalled();
  expect(state.release).not.toHaveBeenCalled();
});
