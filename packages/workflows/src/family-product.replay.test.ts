import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureReview, gateFixture, productInput } from "./resources/testing/gate-fixture.js";
import { currentBundle, withoutPatches, type ReplayBundle } from "./testing/replay/bundles.js";
import { recordHistory, scheduledActivities } from "./testing/replay/history.js";

let environment: TestWorkflowEnvironment;
let bundle: ReplayBundle;
let familyBundle: ReplayBundle;
beforeAll(async () => {
  bundle = await currentBundle();
  // The separate enrichment suite covers its child; replay always uses the unmodified current bundle.
  familyBundle = withoutPatches(bundle, ["product-enrichment-v1"]);
  environment = await TestWorkflowEnvironment.createLocal();
}, 60_000);
afterAll(async () => environment?.teardown());

it.each([
  { legacy: true, known: false, request: "queued", status: "collected" },
  { legacy: true, known: true, request: "queued", status: "collected" },
  { legacy: false, known: false, request: "queued", status: "formula-pending" },
  { legacy: false, known: false, request: "no-amazon-source", status: "no-amazon-source" },
  { legacy: false, known: true, request: "formula-linked", status: "formula-linked" },
])(
  "replays family outcome $status (legacy $legacy, known $known)",
  async (scenario) => {
    const queue = `family-outcome-${randomUUID()}`;
    const gate = gateFixture();
    const recorded = await recordHistory({
      environment,
      queue,
      workflow: "ProductPipelineWorkflow",
      bundle: scenario.legacy
        ? withoutPatches(familyBundle, ["family-formula-outcomes-v1"])
        : familyBundle,
      input: { ...productInput(queue, "wholefoods"), capture: "http" },
      activities: {
        ...gate.activities,
        captureProduct: async () => ({
          status: "captured-family",
          listingId: "B0096M5PBW",
          variantId: null,
          archiveKey: "retained/wf.html",
        }),
        findKnownFormula: async () => (scenario.known ? { operationId: "amazon-label" } : null),
        requestAmazonFormula: async () => ({ status: scenario.request }),
      },
    });
    expect(recorded.result).toMatchObject({ status: scenario.status });
    expect(
      scheduledActivities(recorded.history).filter((name) => name === "requestAmazonFormula"),
    ).toHaveLength(scenario.legacy && scenario.known ? 0 : 1);
    expect(gate.held.size).toBe(0);
    await Worker.runReplayHistory(
      { workflowBundle: bundle },
      recorded.history,
      recorded.workflowId,
    );
  },
  30_000,
);

it.each([false, true])(
  "replays in-flight capture handling (legacy %s)",
  async (legacy) => {
    const queue = `follower-${randomUUID()}`;
    const gate = gateFixture();
    const recorded = await recordHistory({
      environment,
      queue,
      workflow: "ProductPipelineWorkflow",
      bundle: legacy ? withoutPatches(bundle, ["capture-follower-v1"]) : bundle,
      input: { ...productInput(queue, "wholefoods"), capture: "http" },
      activities: {
        ...gate.activities,
        captureProduct: async () => {
          throw ApplicationFailure.nonRetryable("busy", "CAPTURE.IN_FLIGHT");
        },
        reviewProduct: async () => captureReview(),
      },
    });
    expect(recorded.result).toMatchObject({ status: legacy ? "review" : "pending" });
    expect(
      scheduledActivities(recorded.history).filter((name) => name === "reviewProduct"),
    ).toHaveLength(legacy ? 1 : 0);
    expect(gate.held.size).toBe(0);
    await Worker.runReplayHistory(
      { workflowBundle: bundle },
      recorded.history,
      recorded.workflowId,
    );
  },
  30_000,
);
