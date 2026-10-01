import { randomUUID } from "node:crypto";
import { ChannelPlanInputSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { captureReview, gateFixture, productInput } from "./resources/testing/gate-fixture.js";
import {
  childBundle,
  currentBundle,
  pipelineMarkers,
  stopProofMarker,
  withoutPatches,
  type PatchMarker,
  type ReplayBundle,
} from "./testing/replay/bundles.js";
import {
  childCommands,
  expectMarkers,
  heartbeatSeconds,
  recordHistory,
  scheduledActivities,
  type History,
} from "./testing/replay/history.js";
import { pipelineFixture } from "./testing/replay/product-fixture.js";
import type { ProductPlanRequest } from "./pipeline-model.js";
import { permitCommands } from "./testing/replay/permits.js";

let environment: TestWorkflowEnvironment;
let current: ReplayBundle;
let preEnrichment: ReplayBundle;
let children: ReplayBundle;
const recordingBundles = new Map<string, ReplayBundle>();
const cases = [
  { name: "all markers present", missing: [] },
  ...pipelineMarkers.map((marker) => ({ name: `without ${marker}`, missing: [marker] })),
  { name: "before executor stop proof", missing: [stopProofMarker] },
  {
    name: "before heartbeat patches",
    missing: ["download-heartbeat-v1", "label-heartbeat-v1"],
  },
  {
    name: "legacy gate before heartbeat patches",
    missing: ["resource-gate-v1", "download-heartbeat-v1", "label-heartbeat-v1"],
  },
  { name: "before all patches", missing: [...pipelineMarkers, stopProofMarker] },
] satisfies Array<{ name: string; missing: PatchMarker[] }>;

beforeAll(async () => {
  [current, children] = await Promise.all([currentBundle(), childBundle()]);
  preEnrichment = withoutPatches(current, ["product-enrichment-v1"]);
  for (const scenario of cases) {
    recordingBundles.set(scenario.name, withoutPatches(preEnrichment, scenario.missing));
  }
  // Validate the generated contracts even when the local Temporal server cannot start.
  pipelineFixture("replay-preflight");
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

it.each(cases)(
  "replays ProductPipelineWorkflow $name",
  async ({ name, missing }) => {
    const queue = `pipeline-replay-${randomUUID()}`;
    const fixture = pipelineFixture(queue);
    const bundle = recordingBundles.get(name);
    if (!bundle) {
      throw new Error(`Missing recording bundle: ${name}`);
    }
    const child = await Worker.create({
      connection: environment.nativeConnection,
      workflowBundle: children,
      taskQueue: `${queue}-child`,
    });
    const { history, result, workflowId } = await child.runUntil(() =>
      recordHistory({
        environment,
        bundle,
        queue,
        workflow: "ProductPipelineWorkflow",
        input: fixture.input,
        activities: fixture.activities,
      }),
    );
    expect(result).toEqual({ status: "collected", operationId: "label-1", files: 1 });
    const reuse = !missing.includes("formula-reuse-v1");
    const ocr = reuse && !missing.includes("formula-reuse-ocr-v1");
    const shared = !missing.includes("shared-label-workflow-v1");
    expectMarkers(
      history,
      pipelineMarkers.filter(
        (marker) =>
          !missing.includes(marker) &&
          (marker !== "formula-reuse-ocr-v1" || reuse) &&
          (marker !== "label-heartbeat-v1" || ocr),
      ),
    );
    const activities = scheduledActivities(history);
    const captureCommands = permitCommands("captureProduct");
    expect(activities.slice(0, captureCommands.length)).toEqual(captureCommands);
    expect(activities.filter((activity) => activity === "reuseSiblingFormula")).toHaveLength(
      reuse ? 1 : 0,
    );
    expect(activities.filter((activity) => activity === "ocrFile")).toHaveLength(ocr ? 1 : 0);
    expect(activities.filter((activity) => activity === "resolveOcrReceipt")).toHaveLength(
      ocr ? 1 : 0,
    );
    expect(activities.filter((activity) => activity === "prepareLabelTask")).toHaveLength(
      Number(shared) + Number(ocr),
    );
    expect(activities.filter((activity) => activity === "prepareLabelHandoff")).toHaveLength(
      shared ? 0 : 1,
    );
    expect(childCommands(history)).toEqual({
      types: [shared ? "LabelWorkflow" : "ChannelStreamingLabelWorkflow"],
      signals: shared
        ? ["labelSourceReady", "labelStreamSealed"]
        : ["channelSourceReady", "channelStreamSealed"],
    });
    const childIds = history.events?.flatMap((event) => {
      const child = event.startChildWorkflowExecutionInitiatedEventAttributes;
      return child ? [child.workflowId] : [];
    });
    expect(childIds).toEqual([`${workflowId}-label`]);
    expectHeartbeats(history, missing, ocr);
    expect(fixture.gate.calls.reserved).toBe(1);
    expect(fixture.gate.calls.released).toBe(1);
    expect(fixture.gate.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);

function expectHeartbeats(history: History, missing: PatchMarker[], ocr: boolean) {
  const downloadHeartbeat = missing.includes("download-heartbeat-v1") ? 0 : 30;
  const labelHeartbeat = missing.includes("label-heartbeat-v1") ? 0 : 30;
  expect(heartbeatSeconds(history, "acquireProductFile")).toEqual(
    Array.from({ length: ocr ? 2 : 1 }, () => downloadHeartbeat),
  );
  expect(heartbeatSeconds(history, "ocrFile")).toEqual(ocr ? [labelHeartbeat] : []);
}

it.each([false, true])(
  "replays DTC capture and planning (source bound: %s)",
  async (bound) => {
    const queue = `dtc-source-replay-${randomUUID()}`;
    const fixture = pipelineFixture(queue);
    const captured = await fixture.activities.captureProduct();
    const sourcePlan = ChannelPlanInputSchema.parse({
      ...captured.sourcePlan,
      channel: "dtc",
      parserVersion: "dtc-rendered/1",
      expectedUrl: "https://shop.example/products/sleep",
      owner: { ...captured.sourcePlan.owner, sourceId: fixture.input.sourceId },
      source: {
        ...captured.sourcePlan.source,
        sourceId: fixture.input.sourceId,
        producer: {
          ...captured.sourcePlan.source.producer,
          module: "dtc.browser-projection",
          implementationVersion: "dtc-rendered/1",
        },
      },
    });
    const sourceUrl = "https://shop.example/collections/alpha";
    const input = {
      ...fixture.input,
      channel: "dtc",
      capture: "browser",
      url: sourcePlan.expectedUrl,
      ...(bound ? { sourceUrl } : {}),
    };
    const captureBrowserProduct = vi.fn(async (_input: unknown) => ({
      status: "captured",
      listingId: sourcePlan.owner.listingId,
      variantId: sourcePlan.owner.variantId,
      archiveKey: "replay/dtc.html",
      planned: { ...captured, sourcePlan, family: null },
    }));
    const prepareChannelProduct = vi.fn(async (_request: ProductPlanRequest) =>
      fixture.activities.prepareChannelProduct(),
    );
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle: preEnrichment,
      queue,
      workflow: "ProductPipelineWorkflow",
      input,
      activities: {
        ...fixture.activities,
        captureBrowserProduct,
        prepareChannelProduct,
        findKnownFormula: async () => ({ operationId: "known-formula" }),
      },
    });
    expect(result).toMatchObject({ status: "collected", reusedFormula: true });
    expect(captureBrowserProduct).toHaveBeenCalledExactlyOnceWith(input);
    expect(prepareChannelProduct).toHaveBeenCalledExactlyOnceWith(
      bound ? { ...sourcePlan, sourceUrl } : sourcePlan,
    );
    expect(scheduledActivities(history)).toEqual([
      ...permitCommands("captureBrowserProduct"),
      "prepareChannelProduct",
      "findKnownFormula",
    ]);
    expect(fixture.gate.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);

it.each([false, true])(
  "replays resource wait timers and the catch branch (marker present: %s)",
  async (patched) => {
    const queue = `pipeline-failure-${randomUUID()}`;
    const gate = gateFixture();
    const captureProduct = vi.fn();
    const reviewProduct = vi.fn(async (_request: unknown) => captureReview());
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle: patched ? preEnrichment : withoutPatches(preEnrichment, ["resource-gate-v1"]),
      queue,
      workflow: "ProductPipelineWorkflow",
      input: productInput(queue),
      activities: {
        ...gate.activities,
        reserveResources: async ({ permitId }: ResourceRequest) => ({
          permitId,
          status: "waiting",
          reason: "unhealthy",
        }),
        captureProduct,
        reviewProduct,
      },
    });
    expect(result).toEqual(captureReview());
    const request = reviewProduct.mock.calls[0]?.[0];
    expect(request).toMatchObject({ causeCode: "RESOURCE.WAIT_LIMIT" });
    if (patched) {
      expect(request).toHaveProperty("executionFact", "not_executed");
    } else {
      expect(request).not.toHaveProperty("executionFact");
    }
    // No download was reached, so its heartbeat patch must not be evaluated.
    expectMarkers(history, patched ? ["capture-mode-v1", "resource-gate-v1"] : ["capture-mode-v1"]);
    expect(scheduledActivities(history)).toEqual([
      "reserveResources",
      "reserveResources",
      "reviewProduct",
    ]);
    expect(history.events?.filter((event) => event.timerStartedEventAttributes)).toHaveLength(1);
    expect(captureProduct).not.toHaveBeenCalled();
    expect(gate.calls.released).toBe(0);
    expect(gate.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);

it.each([false, true])(
  "replays browser product capture (resource marker present: %s)",
  async (patched) => {
    const queue = `browser-product-replay-${randomUUID()}`;
    const gate = gateFixture();
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle: withoutPatches(
        preEnrichment,
        patched
          ? ["capture-mode-v1", "family-formula-outcomes-v1"]
          : ["capture-mode-v1", "resource-gate-v1", "family-formula-outcomes-v1"],
      ),
      queue,
      workflow: "ProductPipelineWorkflow",
      input: productInput(queue, "wholefoods"),
      activities: {
        ...gate.activities,
        captureBrowserProduct: async () => ({
          status: "captured",
          listingId: "listing-1",
          variantId: null,
          archiveKey: "replay/browser.html",
        }),
        findKnownFormula: async () => ({ operationId: "known-formula" }),
      },
    });
    expect(result).toMatchObject({ status: "collected", reusedFormula: true });
    expectMarkers(history, patched ? ["resource-gate-v1"] : []);
    expect(scheduledActivities(history)).toEqual([
      ...permitCommands("captureBrowserProduct"),
      "findKnownFormula",
    ]);
    expect(gate.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);

it.each(["http", "browser"] as const)(
  "replays explicit %s capture independently of the historical channel route",
  async (capture) => {
    const queue = `capture-mode-replay-${randomUUID()}`;
    const gate = gateFixture();
    const channel = capture === "http" ? "wholefoods" : "swanson";
    const captureProduct = vi.fn(async () => captureReview());
    const captureBrowserProduct = vi.fn(async () => captureReview());
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle: preEnrichment,
      queue,
      workflow: "ProductPipelineWorkflow",
      input: { ...productInput(queue, channel), capture },
      activities: { ...gate.activities, captureProduct, captureBrowserProduct },
    });
    expect(result).toEqual(captureReview());
    expect(scheduledActivities(history)).toEqual(
      permitCommands(capture === "http" ? "captureProduct" : "captureBrowserProduct"),
    );
    const markers = history.events?.flatMap((event) =>
      Object.values(event.markerRecordedEventAttributes?.details ?? {}).flatMap(
        (values) => values.payloads?.map((value) => Buffer.from(value.data ?? []).toString()) ?? [],
      ),
    );
    expect(markers?.some((payload) => payload.includes('"capture-mode-v1"'))).toBe(true);
    expect(gate.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);

it.each([false, true])(
  "replays HTTP formula-family capture (known: %s)",
  async (known) => {
    const queue = `family-http-${randomUUID()}`;
    const gate = gateFixture();
    const input = { ...productInput(queue, "wholefoods"), capture: "http" };
    const requestAmazonFormula = vi.fn(async () => ({ status: "queued" }));
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle: preEnrichment,
      queue,
      workflow: "ProductPipelineWorkflow",
      input,
      activities: {
        ...gate.activities,
        captureProduct: async () => ({
          status: "captured-family",
          listingId: "B0096M5PBW",
          variantId: null,
          archiveKey: "replay/wholefoods.html",
        }),
        findKnownFormula: async () => (known ? { operationId: "amazon-formula" } : null),
        requestAmazonFormula,
        reviewProduct: async () => captureReview(),
      },
    });
    expect(result).toMatchObject({
      status: known ? "formula-linked" : "formula-pending",
      ...(known ? {} : { formulaPending: true }),
    });
    expect(scheduledActivities(history)).toEqual([
      ...permitCommands("captureProduct"),
      "findKnownFormula",
      "requestAmazonFormula",
    ]);
    expectMarkers(history, [
      "capture-mode-v1",
      "resource-gate-v1",
      "formula-family-capture-v1",
      "family-formula-outcomes-v1",
    ]);
    expect(requestAmazonFormula).toHaveBeenCalledOnce();
    expect(gate.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);
