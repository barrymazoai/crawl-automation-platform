import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  activities: {} as Record<string, Record<string, (raw: unknown) => Promise<unknown>>>,
  handlers: {} as Record<string, (raw: unknown) => void>,
}));

vi.mock("@temporalio/workflow", () => {
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
    proxyActivities: ({ taskQueue }: { taskQueue: string }) => env.activities[taskQueue],
    defineSignal: (name: string) => name,
    setHandler: (name: string, handler: (raw: unknown) => void) => {
      env.handlers[name] = handler;
    },
    condition: async (predicate: () => boolean) => {
      await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000, interval: 5 });
    },
    patched: () => true,
    sleep: async () => undefined,
    workflowInfo: () => ({ workflowId: "product-run-1-label", runId: "run-1" }),
    isCancellation: (error: unknown) => (error as { type?: string }).type === "CANCELLED",
    CancellationScope: { nonCancellable: (run: () => unknown) => run() },
    ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
    ActivityFailure: class extends Error {},
    ApplicationFailure,
  };
});

import { ApplicationFailure } from "@temporalio/workflow";
import { collected, entry, pageActivities, textOutcome } from "./label-fixture.js";
import { LabelWorkflow } from "./label-workflow.js";

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
});

it("reads a page-only label once: page text, one model call, manifest, assembly, then collection", async () => {
  const { steps, model } = setup();

  expect(await run()).toEqual(collected);

  expect(model.interpretText).toHaveBeenCalledOnce();
  expect(steps["prepareLabelManifest"]).toHaveBeenCalledOnce();
  expect(steps["collectLabelProduct"]).toHaveBeenCalledOnce();
  expect(steps["reviewLabelProduct"]).not.toHaveBeenCalled();
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

it("a manifest failure keeps the manifest step's own code with the Review", async () => {
  const { steps } = setup();
  steps["prepareLabelManifest"]?.mockRejectedValue(
    ApplicationFailure.nonRetryable("no source", "CHANNEL.LABEL_NO_SOURCE"),
  );

  expect(await run()).toMatchObject({
    status: "review",
    code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
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
