import { expect, it, vi } from "vitest";
import { ActivityFailure, ApplicationFailure, RetryState } from "@temporalio/common";
import { safeErrorSummary } from "@crawl-automation/platform/errors/summary";
import { z } from "zod";
import { LabelWorkflow } from "./label-workflow.js";
import { labelFallbackFixture } from "../testing/replay/label-fallback-fixture.js";

const env = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@temporalio/workflow", async () => ({
  ...(await import("@temporalio/common")),
  patched: () => true,
  isCancellation: () => false,
  log: { info: vi.fn(), warn: vi.fn() },
  workflowInfo: () => ({ runId: "source-diagnostics" }),
}));
vi.mock("./label-stream.js", () => ({
  labelStream: () => ({ demand: true, ready: async () => true, finish: async () => true }),
}));
vi.mock("./label-run.js", async (original) => ({
  ...(await original<object>()),
  labelRun: (entry: unknown, stream: unknown) => ({
    entry,
    stream,
    call: env.call,
    waiting: [],
    quarantined: [],
    heartbeatFailures: [],
  }),
}));

it.each(["coded", "schema"])(
  "keeps a %s preparation cause through unresolved inspection and the final Review",
  async (kind) => {
    const fixture = await labelFallbackFixture();
    fixture.input.input.corePolicy = undefined;
    fixture.input.input.admission = undefined;
    fixture.loaded.input = fixture.input.input;
    const validation = z.object({ document: z.string() }).safeParse({ document: 42 });
    const cause = safeErrorSummary(
      kind === "schema"
        ? validation.error
        : {
            code: "SAVED.OCR_UNCONFIRMED",
            name: "SourceReview",
            message: "OCR receipt missing at https://example.com/?token=private",
          },
    );
    const failure = new ActivityFailure(
      "Activity failed",
      "prepareLabelSource",
      "source",
      RetryState.NON_RETRYABLE_FAILURE,
      "test",
      ApplicationFailure.nonRetryable(
        "Preparation unverified",
        "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
        { cause },
      ),
    );
    const review = vi.fn(fixture.activities.reviewLabelProduct);
    const steps = { ...fixture.activities, reviewLabelProduct: review } as Record<
      string,
      (request: never) => Promise<unknown>
    >;
    env.call.mockReset().mockImplementation(async (_kind, name: string, request: never) => {
      if (name === "prepareLabelSource") {
        throw failure;
      }
      return steps[name]?.(request);
    });
    expect(await LabelWorkflow(fixture.input)).toMatchObject({
      status: "review",
      code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
      automaticRetry: false,
    });
    const expectedCause = { ...cause, code: cause.code ?? "CHANNEL.LABEL_PREPARATION_UNVERIFIED" };
    const diagnostic = {
      sourceId: "page",
      code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
      executionFact: "unknown",
      cause: expectedCause,
    };
    expect(review).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        primaryFailure: diagnostic,
        failures: [diagnostic],
        states: [
          { id: "page", status: "unresolved" },
          { id: "image", status: "not_started" },
        ],
      }),
    );
    expect(env.call.mock.calls.map(([, name]) => name)).toEqual([
      "loadLabelPlan",
      "prepareHtmlPage",
      "preparePageText",
      "prepareLabelSource",
      "inspectLabelImage",
      "reviewLabelProduct",
    ]);
    expect(env.call.mock.calls.find(([, name]) => name === "inspectLabelImage")?.[2]).toMatchObject(
      {
        states: [{ id: "page", status: "unresolved" }],
      },
    );
    expect(JSON.stringify(review.mock.calls)).not.toContain("token=private");
    if (kind === "schema") {
      expect(expectedCause.issues).toEqual([
        expect.objectContaining({ path: ["document"], code: "invalid_type" }),
      ]);
    }
  },
);
