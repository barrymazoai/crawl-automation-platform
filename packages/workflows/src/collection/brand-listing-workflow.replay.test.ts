import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { expectMarkers, recordHistory, scheduledActivities } from "../testing/replay/history.js";
import type { History } from "../testing/replay/history.js";
import { stopProofMarker, withoutPatches, type ReplayBundle } from "../testing/replay/bundles.js";
import { permitCommands, stopProofActivities } from "../testing/replay/permits.js";
import { gateFixture } from "../resources/testing/gate-fixture.js";

let environment: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let preProof: ReplayBundle;

function recordingBundle(proof: boolean) {
  return proof ? bundle : preProof;
}

beforeAll(async () => {
  bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./brand-listing-workflow.ts", import.meta.url)),
  });
  preProof = withoutPatches(bundle, [stopProofMarker]);
  // A real-time local server: with two gated runs in flight, the time-skipping server jumped the clock while the
  // waiting run's workflow task was in progress (task timeouts until the run timed out).
  environment = await TestWorkflowEnvironment.createLocal();
}, 60_000);
afterAll(async () => {
  await environment?.teardown();
});

function input(queue: string, maxWaitSeconds = 10, gapAfterSeconds = 0) {
  return {
    scanId: randomUUID(),
    gapAfterSeconds,
    source: { sourceId: randomUUID(), channel: "swanson", url: "https://example.com/brand" },
    resources: {
      queue,
      maxWaitSeconds,
      activities: { readBrandListing: [{ resourceId: "swanson-brand-scan", units: 1 }] },
    },
  };
}

function listingFixture(ending: string) {
  const held = new Set<string>();
  const readBrandListing = vi.fn(async () => {
    expect(held.size).toBe(1);
    if (ending === "challenge") {
      throw ApplicationFailure.nonRetryable("challenge", "BRAND_SCAN.ACCESS_CHALLENGE");
    }
    return { pages: [], products: [], full: ending !== "review" };
  });
  const reserveResources = vi.fn(async ({ permitId }: ResourceRequest) => {
    if (ending === "wait-limit") {
      return { permitId, status: "waiting", reason: "unhealthy" };
    }
    held.add(permitId);
    return { permitId, status: "granted", reason: "available" };
  });
  const releaseResources = vi.fn(async ({ permitId }: ResourceRequest) => {
    expect(held.delete(permitId)).toBe(true);
    return { permitId, status: "released", reason: "released" };
  });
  return {
    held,
    activities: {
      ...stopProofActivities(held),
      readBrandListing,
      reserveResources,
      releaseResources,
    },
  };
}

function expectGap(history: History, gap: number) {
  const events = history.events ?? [];
  const timers = events.filter((event) => event.timerStartedEventAttributes);
  expect(timers).toHaveLength(gap > 0 ? 1 : 0);
  if (gap > 0) {
    expect(Number(timers[0]?.timerStartedEventAttributes?.startToFireTimeout?.seconds)).toBe(gap);
    const finished = events.findLastIndex((event) => event.timerFiredEventAttributes);
    const released = events.findIndex(
      (event) =>
        event.activityTaskScheduledEventAttributes?.activityType?.name === "releaseResources",
    );
    expect(finished).toBeGreaterThan(-1);
    expect(released).toBeGreaterThan(finished);
  }
}

it.each(
  [
    { ending: "complete", legacy: true, gap: 0 },
    { ending: "challenge", legacy: true, gap: 0 },
    { ending: "complete", legacy: false, gap: 0 },
    { ending: "complete", legacy: false, gap: 1 },
    { ending: "review", legacy: false, gap: 1 },
    { ending: "challenge", legacy: false, gap: 1 },
    { ending: "wait-limit", legacy: false, gap: 1 },
  ].flatMap((scenario) => [false, true].map((proof) => ({ ...scenario, proof }))),
)(
  "replays $ending (legacy=$legacy, gap=$gap, proof=$proof)",
  async ({ ending, legacy, gap, proof }) => {
    const queue = `listing-replay-${randomUUID()}`;
    const { held, activities } = listingFixture(ending);
    const { readBrandListing, releaseResources } = activities;
    const request = input(queue, 10, gap);
    const { gapAfterSeconds: _gap, ...oldRequest } = request;
    const recording = recordingBundle(proof);
    const { history, workflowId } = await recordHistory({
      environment,
      bundle: legacy
        ? withoutPatches(recording, ["brand-listing-gap-v1", "brand-listing-cooldown-v1"])
        : recording,
      queue,
      workflow: "BrandListingWorkflow",
      input: legacy ? oldRequest : request,
      activities,
      fails: ending === "challenge" || ending === "wait-limit",
    });
    expect(held.size).toBe(0);
    expect(readBrandListing).toHaveBeenCalledTimes(ending === "wait-limit" ? 0 : 1);
    expect(releaseResources).toHaveBeenCalledTimes(ending === "wait-limit" ? 0 : 1);
    expect(scheduledActivities(history)).toEqual(
      ending === "wait-limit"
        ? ["reserveResources", "reserveResources"]
        : permitCommands("readBrandListing"),
    );
    expectMarkers(history, [
      ...(legacy ? [] : (["brand-listing-gap-v1", "brand-listing-cooldown-v1"] as const)),
    ]);
    if (ending !== "wait-limit") {
      expectGap(history, gap);
    }
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  },
  30_000,
);

it("serializes two listings at capacity 1 and replays their waiting histories", async () => {
  const queue = `listing-capacity-${randomUUID()}`;
  let reading: () => void = () => undefined;
  let waiting: () => void = () => undefined;
  let finish: () => void = () => undefined;
  const firstReading = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const secondWaiting = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const finishFirst = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // Results are awaited only after both reads returned: awaiting a result lets the test server skip time.
  let bothRead: () => void = () => undefined;
  const readsDone = new Promise<void>((resolve) => {
    bothRead = resolve;
  });
  const held = new Set<string>();
  let reads = 0;
  let firstFinishedAt = 0;
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    workflowBundle: bundle,
    taskQueue: queue,
    activities: {
      ...stopProofActivities(held),
      reserveResources: async ({ permitId }: ResourceRequest) => {
        if (held.size === 1 && !held.has(permitId)) {
          waiting();
          return { permitId, status: "waiting", reason: "capacity" };
        }
        held.add(permitId);
        return { permitId, status: "granted", reason: "available" };
      },
      readBrandListing: async () => {
        reads++;
        expect(held.size).toBe(1);
        if (reads === 1) {
          reading();
          await finishFirst;
          firstFinishedAt = Date.now();
        }
        if (reads === 2) {
          expect(Date.now() - firstFinishedAt).toBeGreaterThanOrEqual(1000);
          bothRead();
        }
        return { products: [] };
      },
      releaseResources: async ({ permitId }: ResourceRequest) => {
        held.delete(permitId);
        return { permitId, status: "released", reason: "released" };
      },
    },
  });
  await worker.runUntil(async () => {
    const start = () =>
      environment.client.workflow.start("BrandListingWorkflow", {
        taskQueue: queue,
        workflowId: randomUUID(),
        // The waiting run must outlast the first listing's real run time plus its backoff polls.
        args: [input(queue, 900, 1)],
      });
    const first = await start();
    await firstReading;
    const second = await start();
    await secondWaiting;
    expect(reads).toBe(1);
    finish();
    await readsDone;
    await Promise.all([first.result(), second.result()]);
    expect(reads).toBe(2);
    expect(held.size).toBe(0);
    for (const handle of [first, second]) {
      await Worker.runReplayHistory(
        { workflowBundle: bundle },
        await handle.fetchHistory(),
        handle.workflowId,
      );
    }
  });
}, 30_000);

it.each(["activity", "gap"])(
  "cancels during %s, releases and replays without finishing the gap",
  async (during) => {
    const queue = `listing-cancel-${randomUUID()}`;
    const fixture = gateFixture();
    const readBrandListing = vi.fn(() =>
      fixture.activities.work(during === "activity" ? "cancel" : "complete"),
    );
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      workflowBundle: bundle,
      taskQueue: queue,
      activities: { ...fixture.activities, readBrandListing },
      maxHeartbeatThrottleInterval: "50 milliseconds",
      defaultHeartbeatThrottleInterval: "50 milliseconds",
    });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("BrandListingWorkflow", {
        taskQueue: queue,
        workflowId: randomUUID(),
        args: [input(queue, 10, 1)],
      });
      await fixture.working;
      if (during === "gap") {
        await vi.waitFor(
          async () => {
            const history = await handle.fetchHistory();
            expect(history.events?.some((event) => event.timerStartedEventAttributes)).toBe(true);
          },
          { interval: 10 },
        );
      }
      expect(fixture.held.size).toBe(1);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      expect(fixture.calls.stopped).toBe(true);
      expect(fixture.calls.released).toBe(1);
      expect(fixture.held.size).toBe(0);
      expect(readBrandListing).toHaveBeenCalledOnce();
      const history = await handle.fetchHistory();
      expect(history.events?.at(-1)?.workflowExecutionCanceledEventAttributes).toBeTruthy();
      expect(history.events?.filter((event) => event.timerStartedEventAttributes)).toHaveLength(
        during === "gap" ? 1 : 0,
      );
      expect(history.events?.some((event) => event.timerFiredEventAttributes)).toBe(false);
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, handle.workflowId);
    });
  },
  30_000,
);

it.each([true, false])(
  "replays the cooldown boundary (pre-cooldown=%s)",
  async (legacy) => {
    const queue = `listing-cooldown-${randomUUID()}`;
    const fixture = listingFixture("complete");
    fixture.activities.readBrandListing.mockResolvedValue({
      pages: [],
      products: [],
      full: false,
      cooldownRequested: true,
    } as Awaited<ReturnType<typeof fixture.activities.readBrandListing>>);
    const request = { ...input(queue), cooldownSeconds: 1 };
    const { history, workflowId } = await recordHistory({
      environment,
      bundle: legacy ? withoutPatches(bundle, ["brand-listing-cooldown-v1"]) : bundle,
      queue,
      workflow: "BrandListingWorkflow",
      input: legacy ? input(queue) : request,
      activities: fixture.activities,
    });
    expectMarkers(history, [
      "brand-listing-gap-v1",
      ...(legacy ? [] : (["brand-listing-cooldown-v1"] as const)),
    ]);
    expectGap(history, legacy ? 0 : 1);
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  },
  30_000,
);
