import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  held: true,
  now: 0,
  patched: true,
  cancelled: false,
  reserve: vi.fn(),
  release: vi.fn(),
  read: vi.fn(),
  sleep: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock("@temporalio/workflow", () => ({
  ApplicationFailure: class extends Error {
    static nonRetryable(message: string, type: string, ...details: unknown[]) {
      return Object.assign(new Error(message), { type, details });
    }
  },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
  CancellationScope: {
    nonCancellable: (run: () => Promise<unknown>) => run(),
    current: () => ({ consideredCancelled: state.cancelled }),
  },
  patched: () => state.patched,
  isCancellation: (error: unknown) => error instanceof Error && error.name === "CancelledFailure",
  workflowInfo: () => ({
    taskQueue: "pipeline",
    runId: "11111111-1111-4111-8111-111111111111",
    workflowId: "scan",
  }),
  proxyActivities: (options: Record<string, unknown>) => {
    state.options.push(options);
    return {
      reserveResources: state.reserve,
      releaseResources: state.release,
      readBrandListing: state.read,
    };
  },
  sleep: (milliseconds: number) => state.sleep(milliseconds),
}));

import { BrandListingWorkflow } from "./brand-listing-workflow.js";

const input = {
  scanId: "22222222-2222-4222-8222-222222222222",
  source: {
    sourceId: "33333333-3333-4333-8333-333333333333",
    channel: "swanson",
    url: "https://example.com",
  },
  resources: {
    queue: "resources",
    maxWaitSeconds: 10,
    activities: {
      readBrandListing: [{ resourceId: "swanson-brand-scan", units: 1 }],
    },
  },
};

beforeEach(() => {
  state.held = true;
  state.now = 0;
  state.patched = true;
  state.cancelled = false;
  state.options = [];
  vi.spyOn(Date, "now").mockImplementation(() => state.now);
  state.reserve.mockReset().mockImplementation(async ({ permitId }) => ({
    permitId,
    status: state.held ? "waiting" : "granted",
    reason: state.held ? "capacity" : "available",
  }));
  state.release.mockReset().mockImplementation(async ({ permitId }) => ({
    permitId,
    status: "released",
    reason: "released",
  }));
  state.read.mockReset().mockResolvedValue({ products: [] });
  state.sleep.mockReset().mockImplementation(async (milliseconds) => {
    state.now += milliseconds;
  });
});
afterEach(() => vi.restoreAllMocks());

it("waits on held capacity 1 without reading a listing, then releases its exact permit", async () => {
  let wake: () => void = () => undefined;
  state.sleep.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      wake = resolve;
    }),
  );
  const pending = BrandListingWorkflow(input);
  await vi.waitFor(() => expect(state.sleep).toHaveBeenCalledOnce());
  expect(state.read).not.toHaveBeenCalled();
  expect(state.release).not.toHaveBeenCalled();
  state.held = false;
  wake();
  await expect(pending).resolves.toEqual({ products: [] });
  expect(state.reserve).toHaveBeenCalledTimes(2);
  expect(state.read).toHaveBeenCalledExactlyOnceWith({
    scanId: input.scanId,
    source: input.source,
  });
  expect(state.release).toHaveBeenCalledExactlyOnceWith(state.reserve.mock.calls[0]?.[0]);
  expect(state.options.at(-1)).toMatchObject({
    taskQueue: "pipeline",
    retry: { maximumAttempts: 1 },
    cancellationType: "WAIT",
    heartbeatTimeout: "30 seconds",
  });
});

it.each(["capacity", "unhealthy"])(
  "bounds %s waiting with the existing RESOURCE.WAIT_LIMIT policy",
  async (reason) => {
    state.reserve.mockImplementation(async ({ permitId }) => ({
      permitId,
      status: "waiting",
      reason,
    }));
    await expect(BrandListingWorkflow(input)).rejects.toMatchObject({
      type: "RESOURCE.WAIT_LIMIT",
    });
    expect(state.read).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
    expect(state.reserve).toHaveBeenCalledTimes(reason === "capacity" ? 400 : 2);
  },
);

it("releases a failed listing without repeating the activity", async () => {
  state.held = false;
  const error = Object.assign(new Error("challenge"), { type: "BRAND_SCAN.ACCESS_CHALLENGE" });
  state.read.mockRejectedValueOnce(error);
  await expect(BrandListingWorkflow(input)).rejects.toBe(error);
  expect(state.read).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledOnce();
});

it.each(["complete", "review", "failure"])(
  "holds the permit after %s until the gap ends",
  async (ending) => {
    state.held = false;
    const result = { products: [], full: ending === "complete" };
    const failure = Object.assign(new Error("challenge"), { type: "BRAND_SCAN.ACCESS_CHALLENGE" });
    state.read.mockImplementation(async () => {
      if (ending === "failure") {
        throw failure;
      }
      return result;
    });
    let finishGap: () => void = () => undefined;
    state.sleep.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishGap = resolve;
      }),
    );
    const pending = BrandListingWorkflow({ ...input, gapAfterSeconds: 1 });
    const settled =
      ending === "failure"
        ? expect(pending).rejects.toBe(failure)
        : expect(pending).resolves.toEqual(result);
    await vi.waitFor(() => expect(state.sleep).toHaveBeenCalledExactlyOnceWith(1000));
    expect(state.read).toHaveBeenCalledOnce();
    expect(state.release).not.toHaveBeenCalled();
    finishGap();
    await settled;
    expect(state.release).toHaveBeenCalledExactlyOnceWith(state.reserve.mock.calls[0]?.[0]);
  },
);

it.each([undefined, 0])(
  "does not schedule a gap when configured as %s",
  async (gapAfterSeconds) => {
    state.held = false;
    await BrandListingWorkflow({ ...input, gapAfterSeconds });
    expect(state.sleep).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  },
);

it("keeps the unpatched command sequence even with a configured gap", async () => {
  state.held = false;
  state.patched = false;
  await BrandListingWorkflow({ ...input, gapAfterSeconds: 1 });
  expect(state.sleep).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledOnce();
});

it.each(["activity", "scope", "gap"])(
  "releases on cancellation during %s without waiting",
  async (during) => {
    state.held = false;
    const cancelled = Object.assign(new Error("cancelled"), { name: "CancelledFailure" });
    if (during === "activity") {
      state.read.mockRejectedValueOnce(cancelled);
    } else if (during === "scope") {
      state.cancelled = true;
    } else {
      state.sleep.mockRejectedValueOnce(cancelled);
    }
    const pending = BrandListingWorkflow({ ...input, gapAfterSeconds: 30 });
    if (during === "scope") {
      await expect(pending).resolves.toEqual({ products: [] });
    } else {
      await expect(pending).rejects.toBe(cancelled);
    }
    expect(state.sleep).toHaveBeenCalledTimes(during === "gap" ? 1 : 0);
    expect(state.release).toHaveBeenCalledOnce();
  },
);
