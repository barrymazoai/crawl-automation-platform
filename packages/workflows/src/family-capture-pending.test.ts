import { ApplicationFailure } from "@temporalio/common";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ pipeline: {} as Record<string, unknown>, current: true }));
vi.mock("@temporalio/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@temporalio/workflow")>()),
  patched: (marker: string) => (marker === "capture-follower-v1" ? state.current : true),
  proxyActivities: () => state.pipeline,
  workflowInfo: () => ({ workflowId: "unit", runId: "unit" }),
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
}));
import { ProductPipelineWorkflow } from "./product-pipeline-workflow.js";
import { productInput } from "./resources/testing/gate-fixture.js";

it.each([true, false])(
  "in-flight capture preserves marker semantics (current %s)",
  async (current) => {
    state.current = current;
    const captureProduct = vi.fn(async () => {
      throw ApplicationFailure.nonRetryable("busy", "CAPTURE.IN_FLIGHT");
    });
    const reviewProduct = vi.fn(async () => ({ status: "review", code: "CAPTURE.IN_FLIGHT" }));
    state.pipeline = { captureProduct, reviewProduct };
    const input = {
      ...productInput("unit", "wholefoods"),
      capture: "http",
      resources: { queue: "unit", activities: {} },
    };
    expect(await ProductPipelineWorkflow(input)).toMatchObject({
      status: current ? "pending" : "review",
      code: "CAPTURE.IN_FLIGHT",
    });
    expect(captureProduct).toHaveBeenCalledOnce();
    expect(reviewProduct).toHaveBeenCalledTimes(current ? 0 : 1);
  },
);
