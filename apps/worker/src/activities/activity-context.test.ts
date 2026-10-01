import { expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({
  Context: {
    current: () => ({
      info: {
        workflowExecution: { workflowId: "product-run-owner-label", runId: "temporal-label" },
      },
    }),
  },
}));

import {
  createLogger,
  currentMeasurement,
  measuredCall,
  type Measurement,
} from "@crawl-automation/platform";
import { activityIdentity } from "./activity-identity.js";
import { inActivityContext, registerActivityMeasurements } from "./activity-context.js";
import { activityOutcome } from "./activity-outcome.js";
import { measuredLabelPlans, measuredListingRequest } from "./activity-provider-context.js";
import type { LabelPlans } from "@crawl-automation/processing";

const log = createLogger({ name: "context-test", destination: { write: () => undefined } });
const owner = { requestId: "product-run", observationId: "observation", sourceId: "brand-source" };
const image = { ...owner, sha256: "a".repeat(64) };

it.each([
  ["OCR", { ...owner, operationId: "step", file: image }],
  ["text", { ...owner, operationId: "step", source: { document: image } }],
  ["vision", { input: { operationId: "step", selection: { observation: owner, image } } }],
  ["preparation", { input: { operationId: "step", owner }, sourceId: "page-source" }],
])("extracts the product owner from %s inputs", (_kind, raw) => {
  expect(activityIdentity(raw)).toMatchObject({
    runId: "product-run",
    operationId: "step",
    sourceId: "brand-source",
  });
});

it("resolves the channel and isolates concurrent nested calls", async () => {
  const events: Measurement[] = [];
  registerActivityMeasurements(log, {
    resolve: async (identity) => ({
      ...identity,
      channel: identity.runId === "first" ? "gnc" : "amazon",
    }),
    record: async (event) => {
      events.push(event);
    },
  });
  await Promise.all(
    ["first", "second"].map((runId) =>
      inActivityContext({ log, raw: { runId } }, () =>
        measuredCall(
          { kind: "model-image", step: "interpret", providerCall: true, cacheHit: false },
          async () => {
            await Promise.resolve();
            return currentMeasurement()?.identity.runId;
          },
        ),
      ),
    ),
  );
  expect(events.map((event) => [event.runId, event.channel]).sort()).toEqual([
    ["first", "gnc"],
    ["second", "amazon"],
  ]);
  expect(events.every((event) => event.workflowId === "product-run-owner-label")).toBe(true);
  expect(currentMeasurement()).toBeUndefined();
});

it("distinguishes saved model results from a real call and never calls a model to measure reuse", async () => {
  await inActivityContext({ log, raw: { runId: "first" } }, async () => {
    expect(activityOutcome("interpretImage", { status: "registered" })).toMatchObject({
      cacheHit: true,
      providerCall: false,
    });
    await measuredCall(
      { kind: "model-image", step: "model", providerCall: true, cacheHit: false },
      async () => "answer",
    );
    expect(activityOutcome("interpretImage", { status: "registered" })).toMatchObject({
      cacheHit: false,
      providerCall: true,
    });
  });
});

it("measures every source preparation, including internal manifest calls", async () => {
  const events: Measurement[] = [];
  registerActivityMeasurements(log, {
    resolve: async (identity) => identity,
    record: async (event) => {
      events.push(event);
    },
  });
  const request = { input: { owner, operationId: "label" }, sourceId: "front" };
  const fake = {
    source: async (_raw: unknown, _signal: AbortSignal) => ({ status: "prepared" }),
    async manifest() {
      await this.source(request, new AbortController().signal);
    },
  };
  const plans = measuredLabelPlans(fake as unknown as LabelPlans);
  await inActivityContext({ log, raw: request }, async () => {
    const signal = new AbortController().signal;
    await plans.source(request, signal);
    await plans.manifest(request, signal);
  });
  expect(events).toHaveLength(2);
  expect(events.every((event) => event.kind === "preparation" && event.cacheHit === false)).toBe(
    true,
  );
  expect(events[1]).toMatchObject({
    sourceId: "front",
    runId: "product-run",
    operationId: "label",
  });
});

it("records each brand page charge and counts archived reads as zero new credits", async () => {
  const events: Measurement[] = [];
  registerActivityMeasurements(log, {
    resolve: async (identity) => identity,
    record: async (event) => {
      events.push(event);
    },
  });
  const request = {
    channel: "amazon" as const,
    scanId: "scan",
    url: "https://example.com/brand",
    label: "page-1",
    answer: "html" as const,
    origins: ["https://example.com"],
    maxBytes: 100,
  };
  const reader = {
    read: vi.fn(async () => ({
      body: "html",
      archiveKey: "scan/page.html",
      creditCost: 5,
      fromArchive: false,
    })),
  };
  await inActivityContext(
    { log, raw: { scanId: "scan", source: { channel: "amazon" } } },
    async () => {
      const signal = new AbortController().signal;
      await measuredListingRequest(reader, request, signal);
      reader.read.mockResolvedValueOnce({
        body: "html",
        archiveKey: "scan/page.html",
        creditCost: 5,
        fromArchive: true,
      });
      await measuredListingRequest(reader, request, signal);
    },
  );
  expect(
    events.map((event) => [event.scanId, event.providerCall, event.cacheHit, event.creditCost]),
  ).toEqual([
    ["scan", true, false, 5],
    ["scan", false, true, 0],
  ]);
});
