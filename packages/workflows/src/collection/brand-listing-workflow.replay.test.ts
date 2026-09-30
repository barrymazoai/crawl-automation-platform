import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { recordHistory, scheduledActivities } from "../testing/replay/history.js";

let environment: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;

beforeAll(async () => {
  bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./brand-listing-workflow.ts", import.meta.url)),
  });
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);
afterAll(async () => {
  await environment?.teardown();
});

function input(queue: string) {
  return {
    scanId: randomUUID(),
    source: { sourceId: randomUUID(), channel: "swanson", url: "https://example.com/brand" },
    resources: {
      queue,
      maxWaitSeconds: 10,
      activities: { readBrandListing: [{ resourceId: "swanson-brand-scan", units: 1 }] },
    },
  };
}

it.each(["complete", "challenge", "wait-limit"])(
  "records and replays a gated listing ending in %s",
  async (ending) => {
    const queue = `listing-replay-${randomUUID()}`;
    const held = new Set<string>();
    const readBrandListing = vi.fn(async () => {
      expect(held.size).toBe(1);
      if (ending === "challenge") {
        throw ApplicationFailure.nonRetryable("challenge", "BRAND_SCAN.ACCESS_CHALLENGE");
      }
      return { pages: [], products: [], full: true };
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
    const { history, workflowId } = await recordHistory({
      environment,
      bundle,
      queue,
      workflow: "BrandListingWorkflow",
      input: input(queue),
      activities: { readBrandListing, reserveResources, releaseResources },
      fails: ending !== "complete",
    });
    expect(held.size).toBe(0);
    expect(readBrandListing).toHaveBeenCalledTimes(ending === "wait-limit" ? 0 : 1);
    expect(releaseResources).toHaveBeenCalledTimes(ending === "wait-limit" ? 0 : 1);
    expect(scheduledActivities(history)).toEqual(
      ending === "wait-limit"
        ? ["reserveResources", "reserveResources"]
        : ["reserveResources", "readBrandListing", "releaseResources"],
    );
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
  const held = new Set<string>();
  let reads = 0;
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    workflowBundle: bundle,
    taskQueue: queue,
    activities: {
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
        args: [input(queue)],
      });
    const first = await start();
    await firstReading;
    const second = await start();
    await secondWaiting;
    expect(reads).toBe(1);
    finish();
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
