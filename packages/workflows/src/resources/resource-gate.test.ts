import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reserve: vi.fn(),
  release: vi.fn(),
  prepare: vi.fn(),
  stop: vi.fn(),
  patched: true,
  log: vi.fn(),
  warn: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
  protected: 0,
  now: 0,
}));

vi.mock("@temporalio/workflow", () => ({
  log: { info: state.log, warn: state.warn },
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
  patched: () => state.patched,
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
    return {
      reserveResources: state.reserve,
      releaseResources: state.release,
      prepareResourceExecution: state.prepare,
      stopResourceExecution: state.stop,
    };
  },
  sleep: async (milliseconds: number) => {
    state.now += milliseconds;
  },
}));

import { resourceGate } from "./resource-gate.js";

const config = {
  queue: "resources",
  maxWaitSeconds: 10,
  stopVerificationSeconds: 150,
  stopVerificationPollSeconds: 5,
  activities: { work: [{ resourceId: "model", units: 1 }] },
};

beforeEach(() => {
  state.reserve.mockReset();
  state.release.mockReset();
  state.prepare.mockReset();
  state.stop.mockReset();
  state.patched = true;
  state.log.mockReset();
  state.warn.mockReset();
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
  state.stop.mockImplementation(async ({ permitId }: { permitId: string }) => ({
    permitId,
    state: "stopped",
    attempts: 1,
  }));
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
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.stop).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledWith(state.reserve.mock.calls[0]?.[0]);
  expect(state.options.map((options) => options.retry)).toMatchObject([
    { maximumAttempts: 1 },
    { maximumAttempts: 3 },
  ]);
});

it.each(["failure", "cancellation", "timeout"])(
  "releases unknown %s only after proof and preserves the error",
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

it("logs requested/granted/released times while retaining the existing wait cadence", async () => {
  state.reserve.mockResolvedValueOnce({
    permitId: "permit-7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11-0",
    status: "waiting",
    reason: "capacity",
  });
  await resourceGate(config)("work", async () => "done");
  expect(state.log.mock.calls.map(([message]) => message)).toEqual([
    "resource permit requested",
    "resource permit granted",
    "resource permit released",
  ]);
  expect(state.log.mock.calls[1]?.[1]).toMatchObject({
    requestedAt: 0,
    grantedAt: 10_000,
    waitMs: 10_000,
  });
  expect(state.log.mock.calls[2]?.[1]).toMatchObject({ releasedAt: 10_000 });
});

it("holds unknown OCR execution after its bounded stop window and preserves the failure", async () => {
  state.stop.mockImplementation(async ({ permitId }: { permitId: string }) => ({
    permitId,
    state: "CLEANUP_UNVERIFIED",
    attempts: 3,
  }));
  const work = vi.fn(async () => {
    throw new Error("OCR outcome unknown");
  });
  await expect(resourceGate(config)("work", work)).rejects.toMatchObject({
    type: "RESOURCE.CLEANUP_UNVERIFIED",
  });
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.stop).toHaveBeenCalledTimes(31);
  expect(state.stop).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cleanupFailure: { message: "Error: OCR outcome unknown" },
    }),
  );
  expect(state.release).not.toHaveBeenCalled();
  expect(work).toHaveBeenCalledOnce();
  expect(state.now).toBe(150_000);
});

it("releases an unknown execution only after its durable stop proof arrives", async () => {
  state.stop.mockResolvedValueOnce({
    permitId: "permit-7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11-0",
    state: "CLEANUP_UNVERIFIED",
    attempts: 1,
  });
  const error = new Error("OCR outcome unknown");
  await expect(
    resourceGate(config)("work", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(state.stop).toHaveBeenCalledTimes(2);
  expect(state.release).toHaveBeenCalledOnce();
  expect(state.stop.mock.invocationCallOrder[1]).toBeLessThan(
    state.release.mock.invocationCallOrder[0] ?? 0,
  );
});

it("a successful result with unproved external cleanup still keeps the permit held", async () => {
  state.stop.mockResolvedValue({ permitId: "wrong", state: "stopped", attempts: 1 });
  await expect(
    resourceGate(config)("work", async () => ({ cleanup: { stopped: false } })),
  ).rejects.toMatchObject({
    type: "RESOURCE.CLEANUP_UNVERIFIED",
  });
  expect(state.release).not.toHaveBeenCalled();
});

it("replays a pre-proof gate without introducing cleanup activity commands", async () => {
  state.patched = false;
  await resourceGate(config)("work", async () => "done");
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.stop).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledOnce();
});

it("keeps known executed failures on the old activity sequence", async () => {
  const { ApplicationFailure } = await import("@temporalio/workflow");
  const failure = ApplicationFailure.nonRetryable("challenge", "BRAND_SCAN.ACCESS_CHALLENGE");
  await expect(
    resourceGate(config)("work", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.stop).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledOnce();
});

it("checks pending cleanup rejected by the release transaction without rerunning work", async () => {
  const { ApplicationFailure } = await import("@temporalio/workflow");
  state.release.mockRejectedValueOnce(
    ApplicationFailure.nonRetryable("pending", "RESOURCE.CLEANUP_UNVERIFIED"),
  );
  const work = vi.fn(async () => ({ status: "review" }));
  await expect(resourceGate(config)("work", work)).resolves.toEqual({ status: "review" });
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledTimes(2);
  expect(work).toHaveBeenCalledOnce();
});

it("waits past OCR's 90 second hard limit for a durable receipt", async () => {
  state.stop.mockImplementation(async ({ permitId }: { permitId: string }) => ({
    permitId,
    state: state.now >= 95_000 ? "stopped" : "CLEANUP_UNVERIFIED",
    attempts: 1,
  }));
  await resourceGate(config)("work", async () => ({ executionFact: "unknown" }));
  expect(state.now).toBe(95_000);
  expect(state.release).toHaveBeenCalledOnce();
});

it("uses a configured bounded window and never releases on unknown", async () => {
  state.stop.mockImplementation(async ({ permitId }: { permitId: string }) => ({
    permitId,
    state: "unknown",
    attempts: 1,
  }));
  await expect(
    resourceGate({ ...config, stopVerificationSeconds: 2, stopVerificationPollSeconds: 1 })(
      "work",
      async () => ({ executionFact: "unknown" }),
    ),
  ).rejects.toMatchObject({ type: "RESOURCE.CLEANUP_UNVERIFIED" });
  expect(state.now).toBe(2_000);
  expect(state.stop).toHaveBeenCalledTimes(3);
  expect(state.release).not.toHaveBeenCalled();
});

it("waits through a browser outage past both old budgets and starts business work exactly once", async () => {
  let polls = 0;
  state.reserve.mockImplementation(async ({ permitId }: { permitId: string }) => ({
    permitId,
    status: ++polls <= 450 ? "waiting" : "granted",
    reason: polls <= 450 ? "browser:BROWSER.UNAVAILABLE" : "available",
  }));
  const work = vi.fn(async () => "done");
  expect(await resourceGate(config)("work", work)).toBe("done");
  expect(state.now).toBe(4_500_000);
  expect(work).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledOnce();
});

it("retains the old browser wait expiry for histories without the outage marker", async () => {
  state.patched = false;
  state.reserve.mockImplementation(async ({ permitId }: { permitId: string }) => ({
    permitId,
    status: "waiting",
    reason: "browser:BROWSER.UNAVAILABLE",
  }));
  const work = vi.fn();
  await expect(resourceGate(config)("work", work)).rejects.toMatchObject({
    type: "RESOURCE.WAIT_LIMIT",
  });
  expect(work).not.toHaveBeenCalled();
  expect(state.now).toBe(10_000);
});

it.each(["timeout", "activity failure", "release failure"])(
  "releases a failed reserve (%s) before rethrowing its original error",
  async (mode) => {
    const failure = new Error(mode);
    state.reserve.mockRejectedValue(failure);
    if (mode === "release failure") {
      state.release.mockRejectedValue(new Error("release unavailable"));
    }
    const work = vi.fn();
    await expect(resourceGate(config)("work", work)).rejects.toBe(failure);
    expect(state.reserve).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledExactlyOnceWith({
      ...state.reserve.mock.calls[0]?.[0],
      reserveFailed: true,
    });
    expect(work).not.toHaveBeenCalled();
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.warn).toHaveBeenCalledTimes(mode === "release failure" ? 1 : 0);
    if (mode === "release failure") {
      expect(state.warn).toHaveBeenCalledWith(
        "resource reserve failure cleanup failed",
        expect.objectContaining({ error: "Error: release unavailable" }),
      );
    }
  },
);

it("keeps the old reserve-error path when the failure-release patch is absent", async () => {
  state.patched = false;
  const failure = new Error("reserve timed out");
  state.reserve.mockRejectedValue(failure);
  const work = vi.fn();
  await expect(resourceGate(config)("work", work)).rejects.toBe(failure);
  expect(state.release).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
