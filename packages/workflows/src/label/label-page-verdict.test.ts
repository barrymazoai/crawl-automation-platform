import { beforeEach, expect, it, vi } from "vitest";
import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  RetryState,
  TimeoutFailure,
} from "@temporalio/common";

const env = vi.hoisted(() => ({
  patched: true,
  call: vi.fn(),
  ready: vi.fn(),
}));
vi.mock("@temporalio/workflow", async () => {
  const common = await import("@temporalio/common");
  return {
    ...common,
    patched: (marker: string) => marker !== "label-page-verdict-fallback-v1" || env.patched,
    workflowInfo: () => ({ runId: "test-run" }),
    log: { info: vi.fn(), warn: vi.fn() },
    isCancellation: (error: unknown) => error instanceof common.CancelledFailure,
  };
});
vi.mock("./label-stream.js", () => ({
  labelStream: () => ({ demand: true, ready: env.ready, finish: async () => true }),
}));
vi.mock("./label-run.js", async (original) => ({
  ...(await original<typeof import("./label-run.js")>()),
  labelRun: (entry: unknown, stream: unknown) => ({
    entry,
    stream,
    call: env.call,
    waiting: [],
    quarantined: [],
    heartbeatFailures: [],
  }),
}));
import { LabelWorkflow } from "./label-workflow.js";
import { labelFallbackFixture } from "../testing/replay/label-fallback-fixture.js";
import { collected, pageTextOutcome, labelSource, textOutcome } from "./label-fixture.js";

type Activity = (request: never) => Promise<unknown>;
function activityFailure(error: ApplicationFailure) {
  return new ActivityFailure(
    "Activity failed",
    "prepareLabelCore",
    "core",
    RetryState.NON_RETRYABLE_FAILURE,
    "test",
    error,
  );
}

async function setup() {
  const fixture = await labelFallbackFixture();
  const steps: Record<string, ReturnType<typeof vi.fn<Activity>>> = Object.fromEntries(
    Object.entries(fixture.activities).map(([name, step]) => [name, vi.fn(step as Activity)]),
  );
  env.call.mockImplementation(async (_kind, name: string, request: never) => {
    const step = steps[name];
    if (!step) {
      throw new Error(`Unexpected activity ${name}`);
    }
    try {
      return await step(request);
    } catch (error) {
      throw error instanceof ApplicationFailure ? activityFailure(error) : error;
    }
  });
  return { ...fixture, steps };
}

beforeEach(() => {
  env.patched = true;
  env.call.mockReset();
  env.ready.mockReset().mockResolvedValue(true);
});

it("processes the image after a wrapped LABEL_CORE verdict, without retrying the page or calling text", async () => {
  const test = await setup();
  expect(await LabelWorkflow(test.input)).toEqual(collected);
  expect(test.steps["prepareLabelCore"]).toHaveBeenCalledOnce();
  expect(test.steps["prepareImageOcr"]).toHaveBeenCalledOnce();
  expect(test.steps["interpretImage"]).toHaveBeenCalledOnce();
  expect(env.call.mock.calls.map(([, name]) => name)).not.toContain("interpretText");
  expect(test.steps["inspectLabelImage"]).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      states: [{ id: "page", status: "not_matched", reason: "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS" }],
    }),
  );
  expect(test.steps["assembleLabelProduct"]).toHaveBeenCalledWith(
    expect.objectContaining({
      states: [{ id: "image", status: "registered" }],
    }),
  );
});

it.each([false, true])("handles prepareLabelSource not_matched (patched: %s)", async (patched) => {
  const test = await setup();
  env.patched = patched;
  test.input.input.corePolicy = undefined;
  test.loaded.input = test.input.input;
  const original = test.activities.prepareLabelSource;
  test.steps["prepareLabelSource"]?.mockImplementation(async (request: { sourceId: string }) =>
    request.sourceId === "page" ? { input: request, status: "not_matched" } : original(request),
  );
  expect(await LabelWorkflow(test.input)).toMatchObject(
    patched
      ? collected
      : {
          status: "review",
          code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
        },
  );
  expect(test.steps["prepareImageOcr"]).toHaveBeenCalledTimes(patched ? 1 : 0);
});

it("keeps the old parser-failure branch without the new patch", async () => {
  const test = await setup();
  env.patched = false;
  expect(await LabelWorkflow(test.input)).toMatchObject({
    status: "review",
    code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
  });
  expect(test.steps["prepareImageOcr"]).not.toHaveBeenCalled();
  expect(test.steps["reviewLabelProduct"]).toHaveBeenCalledWith(
    expect.objectContaining({
      states: [
        { id: "page", status: "unresolved" },
        { id: "image", status: "not_started" },
      ],
    }),
  );
});

it.each([
  ApplicationFailure.nonRetryable("unverified", "LABEL_CORE.HANDOFF_UNVERIFIED"),
  ApplicationFailure.nonRetryable("conflict", "LABEL_CORE.IDENTITY_CONFLICT"),
  ApplicationFailure.nonRetryable("uncoded parser", "LABEL_CORE.EXTRACTION_FAILED"),
  new TimeoutFailure("deadline", undefined, "START_TO_CLOSE"),
  new Error("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS"),
])("keeps unknown outcomes and identity failures terminal: %s", async (failure) => {
  const test = await setup();
  test.steps["prepareLabelCore"]?.mockRejectedValue(failure);
  expect(await LabelWorkflow(test.input)).toMatchObject({
    status: "review",
    code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
  });
  expect(test.steps["prepareImageOcr"]).not.toHaveBeenCalled();
});

it("propagates cancellation and never starts the image", async () => {
  const test = await setup();
  const failure = new CancelledFailure("cancelled");
  test.steps["prepareLabelCore"]?.mockRejectedValue(failure);
  await expect(LabelWorkflow(test.input)).rejects.toBe(failure);
  expect(test.steps["prepareImageOcr"]).not.toHaveBeenCalled();
});

it("stops when page readiness or its evidence identity cannot be verified", async () => {
  const test = await setup();
  env.ready.mockResolvedValue(false);
  expect(await LabelWorkflow(test.input)).toMatchObject({ status: "review" });
  expect(test.steps["prepareLabelCore"]).not.toHaveBeenCalled();
  env.ready.mockResolvedValue(true);
  test.steps["preparePageText"]?.mockResolvedValue({
    ...pageTextOutcome,
    task: { ...pageTextOutcome.task, operationId: "wrong-task" },
  });
  expect(await LabelWorkflow(test.input)).toMatchObject({ status: "review" });
  expect(test.steps["prepareImageOcr"]).not.toHaveBeenCalled();
});

it("includes the page verdict alongside a later image cause when every source is incomplete", async () => {
  const test = await setup();
  const page = {
    sourceId: "page",
    code: "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS",
    executionFact: "executed",
  };
  const image = {
    sourceId: "image",
    code: "VISION.LABEL_FORMULA_INCOMPLETE",
    executionFact: "executed",
  };
  test.steps["inspectLabelImage"]?.mockImplementation(async (request: { states: unknown[] }) => ({
    input: request,
    complete: false,
    terminal: false,
    reason: request.states.length === 1 ? page : image,
    failures: request.states.length === 1 ? [page] : [page, image],
  }));
  expect(await LabelWorkflow(test.input)).toMatchObject({ status: "review", code: image.code });
  expect(test.steps["reviewLabelProduct"]).toHaveBeenCalledWith(
    expect.objectContaining({
      failures: [page, image],
      primaryFailure: image,
    }),
  );
});

it("falls back when source preparation reports a parser verdict before any model task", async () => {
  const test = await setup();
  const input = test.input.input;
  test.steps["prepareLabelCore"]?.mockImplementation(async (request) => ({
    status: "prepared",
    input: request,
    range: pageTextOutcome.task.range,
    document: {
      ...pageTextOutcome.task.source.document,
      producer: {
        operationId: "core",
        module: "label.core.prepare",
        implementationVersion: input.corePolicy,
      },
    },
  }));
  const original = test.activities.prepareLabelSource;
  test.steps["prepareLabelSource"]?.mockImplementation(async (request: { sourceId: string }) => {
    if (request.sourceId === "page") {
      throw ApplicationFailure.nonRetryable("parser verdict", "LABEL_CORE.TABLE_UNVERIFIED");
    }
    return original(request);
  });
  expect(await LabelWorkflow(test.input)).toEqual(collected);
  expect(test.steps["prepareImageOcr"]).toHaveBeenCalledOnce();
});

it("does not reinterpret failures after a text task was issued as parser verdicts", async () => {
  const test = await setup();
  test.input.input.corePolicy = undefined;
  test.loaded.input = test.input.input;
  test.steps["prepareLabelSource"]?.mockImplementation(async (request) => ({
    status: "prepared",
    input: request,
    source: labelSource,
  }));
  test.steps["interpretText"] = vi.fn(async () => textOutcome);
  test.steps["resolveTextReceipt"]?.mockRejectedValue(
    ApplicationFailure.nonRetryable("unknown receipt outcome", "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS"),
  );
  expect(await LabelWorkflow(test.input)).toMatchObject({
    status: "review",
    code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
  });
  expect(test.steps["interpretText"]).toHaveBeenCalledOnce();
  expect(test.steps["prepareImageOcr"]).not.toHaveBeenCalled();
});

it("rejects a page not_matched receipt with the wrong identity", async () => {
  const test = await setup();
  test.input.input.corePolicy = undefined;
  test.loaded.input = test.input.input;
  test.steps["prepareLabelSource"]?.mockResolvedValue({
    status: "not_matched",
    input: { sourceId: "foreign" },
  });
  expect(await LabelWorkflow(test.input)).toMatchObject({
    status: "review",
    code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
  });
  expect(test.steps["prepareImageOcr"]).not.toHaveBeenCalled();
});
