import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import { entry, pageActivities } from "../label/label-fixture.js";
import { gateBundle } from "./testing/gate-bundles.js";
import { captureReview, gateFixture, productInput } from "./testing/gate-fixture.js";

let environment: TestWorkflowEnvironment;
let workflowBundle: Awaited<ReturnType<typeof gateBundle>>;

beforeAll(async () => {
  workflowBundle = await gateBundle();
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

async function scenarioWorker(fixture: ReturnType<typeof gateFixture>, queue: string) {
  return Worker.create({
    connection: environment.nativeConnection,
    workflowBundle,
    taskQueue: queue,
    activities: fixture.activities,
    maxHeartbeatThrottleInterval: "50 milliseconds",
    defaultHeartbeatThrottleInterval: "50 milliseconds",
  });
}

describe("ResourceGate in Temporal", () => {
  it.each(["complete", "review", "failure", "timeout", "scope-timeout"] as const)(
    "%s releases the exact permit and never retries work",
    async (mode) => {
      const queue = `resource-gate-${randomUUID()}`;
      const fixture = gateFixture();
      const worker = await scenarioWorker(fixture, queue);
      await worker.runUntil(async () => {
        const result = environment.client.workflow.execute("GateScenarioWorkflow", {
          taskQueue: queue,
          workflowId: randomUUID(),
          args: [{ queue, mode }],
        });
        if (mode === "complete" || mode === "review") {
          await expect(result).resolves.toMatchObject({
            status: mode === "review" ? "review" : "completed",
          });
        } else {
          await expect(result).rejects.toThrow();
        }
        expect(fixture.calls.released).toBe(1);
        expect(fixture.calls.work).toBe(1);
        expect(fixture.held.size).toBe(0);
      });
    },
    30_000,
  );

  it("cancel mid-work acknowledges stopping, then releases in a non-cancellable scope", async () => {
    const queue = `resource-cancel-${randomUUID()}`;
    const fixture = gateFixture();
    const worker = await scenarioWorker(fixture, queue);
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("GateScenarioWorkflow", {
        taskQueue: queue,
        workflowId: randomUUID(),
        args: [{ queue, mode: "cancel" }],
      });
      await fixture.working;
      expect(fixture.held.size).toBe(1);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      expect(fixture.calls.stopped).toBe(true);
      expect(fixture.calls.released).toBe(1);
      expect(fixture.held.size).toBe(0);
    });
  }, 30_000);

  it("repeats an idempotent release after its committed reply is lost", async () => {
    const queue = `resource-repeat-${randomUUID()}`;
    const fixture = gateFixture();
    fixture.calls.releaseFailures = 1;
    const worker = await scenarioWorker(fixture, queue);
    await worker.runUntil(async () => {
      await environment.client.workflow.execute("GateScenarioWorkflow", {
        taskQueue: queue,
        workflowId: randomUUID(),
        args: [{ queue, mode: "complete" }],
      });
      expect(fixture.calls.released).toBe(2);
      expect(fixture.calls.reserved).toBe(1);
      expect(fixture.calls.work).toBe(1);
      expect(fixture.held.size).toBe(0);
    });
  });

  it("a cancellation during reserve still observes and releases the committed grant", async () => {
    const queue = `reserve-cancel-${randomUUID()}`;
    const fixture = gateFixture();
    let entered: () => void = () => undefined;
    let grant: () => void = () => undefined;
    const reserving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const permission = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const reserve = fixture.activities.reserveResources;
    fixture.activities.reserveResources = async (request) => {
      entered();
      await permission;
      return reserve(request);
    };
    const worker = await scenarioWorker(fixture, queue);
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("GateScenarioWorkflow", {
        taskQueue: queue,
        workflowId: randomUUID(),
        args: [{ queue, mode: "complete" }],
      });
      await reserving;
      await handle.cancel();
      grant();
      await expect(handle.result()).rejects.toThrow();
      expect(fixture.calls.work).toBe(0);
      expect(fixture.calls.released).toBe(1);
      expect(fixture.held.size).toBe(0);
    });
  });

  it("an unsuccessful reserve is never automatically retried", async () => {
    const queue = `reserve-failed-${randomUUID()}`;
    const fixture = gateFixture();
    const reserve = vi.fn(async () => {
      throw new Error("ledger unavailable");
    });
    fixture.activities.reserveResources = reserve;
    const worker = await scenarioWorker(fixture, queue);
    await worker.runUntil(async () => {
      await expect(
        environment.client.workflow.execute("GateScenarioWorkflow", {
          taskQueue: queue,
          workflowId: randomUUID(),
          args: [{ queue, mode: "complete" }],
        }),
      ).rejects.toThrow();
      expect(reserve).toHaveBeenCalledOnce();
      expect(fixture.calls.work).toBe(0);
      expect(fixture.calls.released).toBe(1);
    });
  });

  it.each(["swanson", "wholefoods"])(
    "%s capture wait expiry records its reason and not_executed",
    async (channel) => {
      const queue = `resource-wait-${randomUUID()}`;
      const work = vi.fn();
      const reviewProduct = vi.fn(async () => captureReview());
      const releaseResources = vi.fn();
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        workflowBundle,
        taskQueue: queue,
        activities: {
          reserveResources: async ({ permitId }: ResourceRequest) => ({
            permitId,
            status: "waiting",
            reason: "unhealthy",
          }),
          releaseResources,
          captureProduct: work,
          captureBrowserProduct: work,
          reviewProduct,
        },
      });
      await worker.runUntil(async () => {
        await environment.client.workflow.execute("ProductPipelineWorkflow", {
          taskQueue: queue,
          workflowId: randomUUID(),
          args: [productInput(queue, channel)],
        });
        expect(reviewProduct).toHaveBeenCalledWith(
          expect.objectContaining({
            causeCode: "RESOURCE.WAIT_LIMIT",
            executionFact: "not_executed",
          }),
        );
        expect(work).not.toHaveBeenCalled();
        expect(releaseResources).not.toHaveBeenCalled();
      });
    },
  );

  it("Label wait expiry records a not_executed source without calling the model", async () => {
    const queue = `label-wait-${randomUUID()}`;
    const steps = pageActivities();
    const reviewLabelProduct = vi.fn(steps.reviewLabelProduct);
    const interpretText = vi.fn();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      workflowBundle,
      taskQueue: queue,
      activities: {
        ...steps,
        reviewLabelProduct,
        interpretText,
        reserveResources: async ({ permitId }: ResourceRequest) => ({
          permitId,
          status: "waiting",
          reason: "unhealthy",
        }),
      },
    });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("LabelWorkflow", {
        taskQueue: queue,
        workflowId: randomUUID(),
        args: [
          {
            ...entry,
            queues: { activities: queue, model: queue, ocr: queue },
            resources: {
              queue,
              maxWaitSeconds: 10,
              activities: {
                interpretText: [{ resourceId: "test-model", units: 1 }],
              },
            },
          },
        ],
      });
      await handle.signal("labelStreamSealed", { operationId: "label-1", status: "closed" });
      await handle.result();
      expect(reviewLabelProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          failures: [
            { sourceId: "page", code: "RESOURCE.WAIT_LIMIT", executionFact: "not_executed" },
          ],
        }),
      );
      expect(interpretText).not.toHaveBeenCalled();
    });
  });
});
