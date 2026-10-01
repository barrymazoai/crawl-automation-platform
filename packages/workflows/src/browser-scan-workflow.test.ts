import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  patched: true,
  cancelled: false,
  scan: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  stop: vi.fn(),
  sleep: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock("@temporalio/workflow", async () => ({
  ApplicationFailure: (
    await vi.importActual<typeof import("@temporalio/common")>("@temporalio/common")
  ).ApplicationFailure,
  log: { info: vi.fn() },
  proxyActivities: (options: Record<string, unknown>) => {
    state.options.push(options);
    return {
      scanBrandInBrowser: state.scan,
      reserveResources: state.reserve,
      releaseResources: state.release,
      prepareResourceExecution: async () => undefined,
      stopResourceExecution: state.stop,
    };
  },
  workflowInfo: () => ({
    taskQueue: "browser",
    workflowId: "scan",
    runId: "11111111-1111-4111-8111-111111111111",
  }),
  patched: () => state.patched,
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
  CancellationScope: {
    nonCancellable: (run: () => Promise<unknown>) => run(),
    current: () => ({ consideredCancelled: state.cancelled }),
  },
  isCancellation: (error: unknown) => error instanceof Error && error.name === "CancelledFailure",
  sleep: (milliseconds: number) => state.sleep(milliseconds),
}));

beforeEach(() => {
  state.patched = true;
  state.cancelled = false;
  state.options = [];
  state.scan.mockReset().mockImplementation(async (input: unknown) => input);
  state.reserve.mockReset().mockImplementation(async ({ permitId }) => ({
    permitId,
    status: "granted",
    reason: "available",
  }));
  state.release.mockReset().mockImplementation(async ({ permitId }) => ({
    permitId,
    status: "released",
    reason: "released",
  }));
  state.stop
    .mockReset()
    .mockImplementation(async ({ permitId }) => ({ permitId, state: "stopped", attempts: 1 }));
  state.sleep.mockReset().mockResolvedValue(undefined);
});

import { BrowserScanInputSchema, BrowserScanWorkflow } from "./browser-scan-workflow.js";

const input = { channel: "wholefoods", scanId: "scan", sourceUrl: "https://example.com/brand" };

it("keeps the old activity payload exactly when capture is absent", async () => {
  expect(BrowserScanInputSchema.parse(input)).toEqual(input);
  expect(await BrowserScanWorkflow(input)).toEqual(input);
});

it.each(["dtc", "gnc", "amazon", "wholefoods", "swanson", "costco"])(
  "passes an explicit browser capability for %s",
  async (channel) => {
    const request = { ...input, channel, capture: "browser" };
    expect(await BrowserScanWorkflow(request)).toEqual(request);
  },
);

it("refuses HTTP on the browser-only workflow", () => {
  expect(() => BrowserScanInputSchema.parse({ ...input, capture: "http" })).toThrow();
});

it("preserves the DTC database source ID with its catalog through the scan activity", async () => {
  const request = { ...input, channel: "dtc", sourceId: "22222222-2222-4222-8222-222222222222" };
  expect(await BrowserScanWorkflow(request)).toEqual(request);
});

const gated = {
  ...input,
  gapAfterSeconds: 60,
  cooldownSeconds: 1800,
  resources: {
    queue: "resources",
    maxWaitSeconds: 900,
    activities: { scanBrandInBrowser: [{ resourceId: "wholefoods-brand-scan", units: 1 }] },
  },
};

it.each(
  ["wholefoods", "costco"].flatMap((channel) =>
    ["complete", "broken", "throttled", "failure"].map((ending) => ({ channel, ending })),
  ),
)("holds the $channel permit through $ending and its delay", async ({ channel, ending }) => {
  const result = { complete: ending === "complete", cooldownRequested: ending === "broken" };
  const failure = {
    cause: ApplicationFailure.nonRetryable(
      "scan failed",
      ending === "throttled" ? `${channel.toUpperCase()}.SEARCH_THROTTLED` : "BROWSER.UNAVAILABLE",
      { cooldownRequested: ending === "throttled" },
    ),
  };
  const fails = ending === "throttled" || ending === "failure";
  state.scan.mockImplementation(async () => {
    if (fails) {
      throw failure;
    }
    return result;
  });
  let finish: () => void = () => undefined;
  state.sleep.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = BrowserScanWorkflow({
    ...gated,
    channel,
    resources: {
      ...gated.resources,
      activities: { scanBrandInBrowser: [{ resourceId: `${channel}-brand-scan`, units: 1 }] },
    },
  });
  const outcome = fails
    ? expect(pending).rejects.toBe(failure)
    : expect(pending).resolves.toBe(result);
  await vi.waitFor(() =>
    expect(state.sleep).toHaveBeenCalledExactlyOnceWith(
      ending === "broken" || ending === "throttled" ? 1_800_000 : 60_000,
    ),
  );
  expect(state.reserve).toHaveBeenCalledOnce();
  expect(state.scan).toHaveBeenCalledExactlyOnceWith({ ...input, channel });
  expect(state.reserve.mock.calls[0]?.[0].needs).toEqual([
    { resourceId: `${channel}-brand-scan`, units: 1 },
  ]);
  expect(state.release).not.toHaveBeenCalled();
  expect(state.options.at(-1)).toMatchObject({
    retry: { maximumAttempts: 1 },
    cancellationType: "WAIT",
    heartbeatTimeout: "30 seconds",
  });
  finish();
  await outcome;
  expect(state.release).toHaveBeenCalledExactlyOnceWith(state.reserve.mock.calls[0]?.[0]);
  expect(state.stop).not.toHaveBeenCalled();
});

it("does not scan while another machine holds capacity", async () => {
  state.reserve.mockResolvedValueOnce({
    permitId: "permit-11111111-1111-4111-8111-111111111111-0",
    status: "waiting",
    reason: "capacity",
  });
  let wake: () => void = () => undefined;
  state.sleep.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      wake = resolve;
    }),
  );
  const pending = BrowserScanWorkflow(gated);
  await vi.waitFor(() => expect(state.sleep).toHaveBeenCalledOnce());
  expect(state.scan).not.toHaveBeenCalled();
  wake();
  await pending;
  expect(state.reserve).toHaveBeenCalledTimes(2);
  expect(state.scan).toHaveBeenCalledOnce();
});

it("replays the old unpatched activity sequence without permits or timers", async () => {
  state.patched = false;
  await BrowserScanWorkflow(gated);
  expect(state.scan).toHaveBeenCalledExactlyOnceWith(input);
  expect(state.reserve).not.toHaveBeenCalled();
  expect(state.sleep).not.toHaveBeenCalled();
  expect(state.release).not.toHaveBeenCalled();
});

it.each(["activity", "gap", "cooldown"])(
  "releases after cancellation during %s without retry",
  async (during) => {
    const cancelled = Object.assign(new Error("cancelled"), { name: "CancelledFailure" });
    if (during === "activity") {
      state.scan.mockRejectedValueOnce(cancelled);
    } else {
      state.scan.mockResolvedValueOnce({ cooldownRequested: during === "cooldown" });
      state.sleep.mockRejectedValueOnce(cancelled);
    }
    await expect(BrowserScanWorkflow(gated)).rejects.toBe(cancelled);
    expect(state.scan).toHaveBeenCalledOnce();
    expect(state.sleep).toHaveBeenCalledTimes(during === "activity" ? 0 : 1);
    expect(state.release).toHaveBeenCalledOnce();
  },
);
