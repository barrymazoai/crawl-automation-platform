import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  activities: {} as Record<string, Record<string, (raw: unknown) => Promise<unknown>>>,
  handlers: {} as Record<string, (raw: unknown) => void>,
  missingPatches: [] as string[],
}));

vi.mock("@temporalio/workflow", async () => {
  const { TimeoutFailure } = await import("@temporalio/common");
  class ApplicationFailure extends Error {
    constructor(
      message: string,
      readonly type?: string,
    ) {
      super(message);
    }
    static nonRetryable(message: string, type?: string) {
      return new ApplicationFailure(message, type);
    }
  }
  return {
    log: { warn: vi.fn(), info: vi.fn() },
    getExternalWorkflowHandle: () => ({
      signal: async (name: string) => {
        if (name === "labelSourcesFinished") {
          env.handlers["labelStreamSealed"]?.({ operationId: "label-1", status: "closed" });
        }
      },
    }),
    proxyActivities: ({ taskQueue }: { taskQueue: string }) => env.activities[taskQueue],
    defineSignal: (name: string) => name,
    setHandler: (name: string, handler: (raw: unknown) => void) => {
      env.handlers[name] = handler;
    },
    condition: async (predicate: () => boolean) => {
      await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000, interval: 5 });
    },
    patched: (marker: string) => !env.missingPatches.includes(marker),
    sleep: async () => undefined,
    workflowInfo: () => ({
      workflowId: "product-run-1-label",
      runId: "run-1",
      parent: { workflowId: "parent", runId: "parent-run" },
    }),
    isCancellation: (error: unknown) => (error as { type?: string }).type === "CANCELLED",
    CancellationScope: { nonCancellable: (run: () => unknown) => run() },
    ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
    ActivityFailure: class extends Error {},
    ApplicationFailure,
    TimeoutFailure,
  };
});

import { ApplicationFailure } from "@temporalio/workflow";
import { TimeoutFailure } from "@temporalio/common";
import { activityCodes } from "@crawl-automation/platform/errors/activity";
import { collected, entry, pageActivities, textOutcome } from "./label-fixture.js";
import { LabelWorkflow } from "./label-workflow.js";
import { pipelineFixture } from "../testing/replay/product-fixture.js";
import { DefaultKeywordPolicy, observationIdentity } from "@crawl-automation/v3-contracts";

function setup() {
  const activities = pageActivities();
  const model = { interpretText: vi.fn(async (): Promise<unknown> => textOutcome) };
  type Step = (raw: unknown) => Promise<unknown>;
  const steps: Record<string, ReturnType<typeof vi.fn<Step>>> = Object.fromEntries(
    Object.entries(activities).map(([name, run]) => [name, vi.fn<Step>(run as Step)]),
  );
  env.activities = { activities: steps, model, ocr: {} };
  return { steps, model };
}

/** Starts the workflow and seals the file stream as the pipeline would once every download finished. */
async function run(seal: "closed" | "failed" = "closed") {
  const result = LabelWorkflow(entry);
  await vi.waitFor(() => expect(env.handlers["labelStreamSealed"]).toBeDefined());
  env.handlers["labelStreamSealed"]?.({ operationId: "label-1", status: seal });
  return result;
}

beforeEach(() => {
  env.handlers = {};
  env.missingPatches = [];
});

it("reads a page-only label once: page text, one model call, manifest, assembly, then collection", async () => {
  const { steps, model } = setup();

  expect(await run()).toEqual(collected);

  expect(model.interpretText).toHaveBeenCalledOnce();
  expect(steps["prepareLabelManifest"]).toHaveBeenCalledOnce();
  expect(steps["collectLabelProduct"]).toHaveBeenCalledOnce();
  expect(steps["reviewLabelProduct"]).not.toHaveBeenCalled();
});

it("a registered empty image is skipped with no_text while the page label is collected", async () => {
  const { steps } = setup();
  const fixture = pipelineFixture("test");
  const { task } = await fixture.activities.prepareImageOcr();
  const planned = await fixture.activities.prepareChannelProduct();
  if (planned.status !== "prepared") {
    throw new Error("Expected a prepared plan");
  }
  const image = planned.manifest.sources[0];
  if (!image) {
    throw new Error("Expected image fixture");
  }
  const original = pageActivities();
  const loaded = await original.loadLabelPlan();
  const ref = (name: string) => ({
    ...task.file,
    artifactId: name,
    objectKey: `ocr/${name}.json`,
    kind: "result-json",
    mediaType: "application/json",
    producer: {
      operationId: task.operationId,
      module: task.module,
      implementationVersion: task.implementationVersion,
    },
  });
  const registration = {
    schemaVersion: 1,
    storageId: "test/1",
    input: task,
    result: ref("result"),
    completion: ref("completion"),
  };
  const selection = {
    schemaVersion: 1,
    observation: observationIdentity(task),
    image: task.file,
    ocrOperationId: task.operationId,
    ocrTextSha256: "a".repeat(64),
    policy: DefaultKeywordPolicy,
    policyFingerprint: "b".repeat(64),
    status: "not_matched",
    matchedKeywords: [],
  };
  const ocrFile = vi.fn(async () => ({
    status: "registered",
    operationId: task.operationId,
    resultRegistered: true,
    result: registration.result,
    completion: registration.completion,
  }));
  env.activities["ocr"] = { ocrFile };
  steps["loadLabelPlan"]?.mockResolvedValue({
    ...loaded,
    manifest: { ...loaded.manifest, sources: [...loaded.manifest.sources, image] },
  });
  steps["prepareImageOcr"] = vi.fn(fixture.activities.prepareImageOcr);
  steps["resolveOcrReceipt"] = vi.fn(async () => ({ status: "registered", registration }));
  steps["screenImageKeywords"] = vi.fn(async () => ({
    status: "not_matched",
    imageId: task.file.artifactId,
    evidenceKey: "keywords/image.json",
    selection,
  }));
  steps["prepareLabelSource"]?.mockImplementation(async (request) =>
    (request as { sourceId: string }).sourceId === image.id
      ? { status: "not_matched", reason: "no_text", input: request }
      : original.prepareLabelSource(request),
  );
  steps["prepareLabelManifest"]?.mockResolvedValue({
    ...(await original.prepareLabelManifest()),
    skipped: [image.id],
  });
  const result = LabelWorkflow(entry);
  await vi.waitFor(() => expect(env.handlers["labelSourceReady"]).toBeDefined());
  env.handlers["labelSourceReady"]?.({
    operationId: entry.input.operationId,
    sourceId: image.id,
    file: task.file,
  });
  env.handlers["labelStreamSealed"]?.({ operationId: entry.input.operationId, status: "closed" });
  expect(await result).toEqual(collected);
  expect(ocrFile).toHaveBeenCalledOnce();
  expect(steps["reviewLabelProduct"]).not.toHaveBeenCalled();
  expect(steps["assembleLabelProduct"]).toHaveBeenCalledWith(
    expect.objectContaining({
      states: [{ id: "page", status: "registered" }],
    }),
  );
});

it("a lost model answer is settled by the receipt, never by a second model call", async () => {
  const { model, steps } = setup();
  model.interpretText.mockRejectedValue(new Error("answer lost"));

  expect(await run()).toEqual(collected);

  expect(model.interpretText).toHaveBeenCalledOnce();
  expect(steps["resolveTextReceipt"]).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: null }),
  );
});

it("a failed file stream ends in the label Review before any manifest", async () => {
  const { steps } = setup();

  expect(await run("failed")).toMatchObject({
    status: "review",
    code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
  });

  expect(steps["prepareLabelManifest"]).not.toHaveBeenCalled();
});

it("a source held up by its model permit ends in a dependency Review naming it", async () => {
  const { model, steps } = setup();
  model.interpretText.mockRejectedValue(
    ApplicationFailure.nonRetryable("waited too long", "RESOURCE.WAIT_LIMIT"),
  );

  expect(await run()).toMatchObject({ status: "review", code: "CHANNEL.DEPENDENCY_UNAVAILABLE" });

  expect(steps["reviewLabelProduct"]).toHaveBeenCalledWith(
    expect.objectContaining({
      failures: [{ sourceId: "page", code: "RESOURCE.WAIT_LIMIT", executionFact: "not_executed" }],
    }),
  );
  expect(steps["resolveTextReceipt"]).not.toHaveBeenCalled();
});

it.each([
  [false, "CHANNEL.LABEL_NO_SOURCE"],
  [true, "CHANNEL.LABEL_PREPARATION_UNVERIFIED"],
] as const)("no label has its own Review (old history: %s)", async (legacy, code) => {
  env.missingPatches = legacy ? ["label-no-source-review-v1"] : [];
  const { steps } = setup();
  steps["prepareLabelManifest"]?.mockRejectedValue(
    ApplicationFailure.nonRetryable("no source", "CHANNEL.LABEL_NO_SOURCE"),
  );

  expect(await run()).toMatchObject({
    status: "review",
    code,
  });

  expect(steps["reviewLabelProduct"]).toHaveBeenCalledWith(
    expect.objectContaining({
      failures: [
        { sourceId: "manifest", code: "CHANNEL.LABEL_NO_SOURCE", executionFact: "executed" },
      ],
    }),
  );
  expect(steps["collectLabelProduct"]).not.toHaveBeenCalled();
});

it("an actual preparation failure still stops as unverified", async () => {
  const { steps } = setup();
  steps["prepareLabelManifest"]?.mockRejectedValue(
    ApplicationFailure.nonRetryable("unconfirmed", "SAVED.OCR_UNCONFIRMED"),
  );
  expect(await run()).toMatchObject({
    status: "review",
    code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
  });
  expect(steps["collectLabelProduct"]).not.toHaveBeenCalled();
});

it("a manifest that does not account for every source is refused before collection", async () => {
  const { steps } = setup();
  const original = pageActivities().prepareLabelManifest;
  steps["prepareLabelManifest"]?.mockImplementation(async () => ({
    ...(await original()),
    skipped: ["page"],
  }));

  await expect(run()).rejects.toMatchObject({ type: "CHANNEL.LABEL_IDENTITY_CONFLICT" });

  expect(steps["collectLabelProduct"]).not.toHaveBeenCalled();
});

it.each([
  "loadLabelPlan",
  "prepareHtmlPage",
  "preparePageText",
  "prepareLabelSource",
  "interpretText",
  "resolveTextReceipt",
  "prepareLabelManifest",
  "assembleLabelProduct",
  "collectLabelProduct",
])(
  "%s heartbeat expiry becomes a Review with the registered cause, never a retry",
  async (name) => {
    const { steps, model } = setup();
    const activity = name === "interpretText" ? model.interpretText : steps[name];
    const failure = new Error("Activity failed", {
      cause: new TimeoutFailure("Heartbeat expired", undefined, "HEARTBEAT"),
    });
    activity?.mockRejectedValue(failure);

    expect(await run()).toMatchObject({ status: "review", automaticRetry: false });
    expect(activity).toHaveBeenCalledOnce();
    expect(steps["reviewLabelProduct"]).toHaveBeenCalledWith(
      expect.objectContaining({
        failures: [
          expect.objectContaining({
            code: activityCodes.heartbeatTimeout,
            executionFact: "unknown",
          }),
        ],
      }),
    );
    if (name === "interpretText") {
      expect(steps["resolveTextReceipt"]).not.toHaveBeenCalled();
    }
  },
);

it("a heartbeat timeout writing the Review escapes without a second Review write", async () => {
  const { steps } = setup();
  const timeout = new TimeoutFailure("Heartbeat expired", undefined, "HEARTBEAT");
  steps["reviewLabelProduct"]?.mockRejectedValue(timeout);
  await expect(run("failed")).rejects.toBe(timeout);
  expect(steps["reviewLabelProduct"]).toHaveBeenCalledOnce();
});

it("runs a versioned text-first workflow through its selection manifest without image work", async () => {
  const { steps, model } = setup();
  const original = pageActivities();
  const loaded = await original.loadLabelPlan();
  const input = {
    ...entry.input,
    sourcePolicy: { version: "label-sources/1", order: "text-first" },
    evidencePolicy: "label-image-first/6",
  };
  steps["loadLabelPlan"]?.mockResolvedValue({
    ...loaded,
    input,
    imageOrder: [],
    labelPreparation: { pageHasLabelSection: true, pageFactsComplete: true },
  });
  steps["inspectLabelImage"] = vi.fn(async (request) => ({
    input: request,
    complete: true,
    terminal: false,
  }));
  const prepared = await original.prepareLabelManifest();
  steps["prepareSingleLabelManifest"] = vi.fn(async () => ({
    ...prepared,
    input,
    manifest: { ...prepared.manifest, evidencePolicy: input.evidencePolicy },
  }));
  expect(await LabelWorkflow({ ...entry, input })).toEqual(collected);
  expect(model.interpretText).toHaveBeenCalledOnce();
  expect(steps["prepareLabelManifest"]).not.toHaveBeenCalled();
  expect(steps["prepareSingleLabelManifest"]).toHaveBeenCalledOnce();
});
