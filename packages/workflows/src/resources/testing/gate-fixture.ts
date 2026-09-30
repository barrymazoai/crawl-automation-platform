import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import type { GateScenario } from "./gate-workflows.js";

export function gateFixture() {
  const held = new Set<string>();
  const calls = { reserved: 0, released: 0, work: 0, stopped: false, releaseFailures: 0 };
  let started: () => void = () => undefined;
  const working = new Promise<void>((resolve) => {
    started = resolve;
  });
  const activities = {
    reserveResources: async (request: ResourceRequest) => {
      calls.reserved++;
      held.add(request.permitId);
      return { permitId: request.permitId, status: "granted", reason: "available" };
    },
    releaseResources: async (request: ResourceRequest) => {
      calls.released++;
      held.delete(request.permitId);
      if (calls.released <= calls.releaseFailures) {
        throw new Error("release reply lost after commit");
      }
      return { permitId: request.permitId, status: "released", reason: "released" };
    },
    work: async (mode: GateScenario["mode"]) => {
      calls.work++;
      started();
      try {
        return await simulatedWork(mode);
      } finally {
        calls.stopped = true;
      }
    },
  };
  return { held, calls, working, activities };
}

async function simulatedWork(mode: GateScenario["mode"]): Promise<unknown> {
  if (mode === "failure") {
    throw ApplicationFailure.nonRetryable("simulated provider failure", "TEST.WORK_FAILED");
  }
  if (mode === "complete" || mode === "review") {
    return { status: mode === "review" ? "review" : "completed" };
  }
  const context = Context.current();
  const timer = setInterval(() => context.heartbeat(), 25);
  try {
    await context.cancelled;
  } finally {
    clearInterval(timer);
  }
}

export function productInput(queue: string, channel = "swanson") {
  return {
    codec: "product-pipeline/1",
    runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
    channel,
    url: "https://example.com/product",
    brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    operationId: "gate-capture-1",
    queues: { activities: queue, plan: queue, label: queue, browser: queue },
    resources: {
      queue,
      maxWaitSeconds: 10,
      releaseOnReview: true,
      reviewStopCheck: true,
      activities: { captureProduct: [{ resourceId: "test-resource", units: 1 }] },
    },
  };
}

export function captureReview() {
  return {
    status: "review",
    operationId: "gate-capture-1",
    reviewId: "gate-review-1",
    code: "RESOURCE.WAIT_LIMIT",
    evidenceKey: "reviews/gate.json",
    automaticRetry: false,
  };
}
