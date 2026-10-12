import { beforeEach, expect, it, vi } from "vitest";
import { ReviewRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
// These tests join the actual workflow and processing inspector with retained fixture evidence. The app's Review
// writer is covered in packages/app (label-review-diagnostics.test.ts); here we check what the workflow hands it.
/* eslint-disable no-restricted-imports */
import { decodeJson } from "../../../processing/src/results/result-record.js";
import { orderedProgressKey } from "../../../processing/src/label/ordered-diagnostics.js";
import type { LabelPlanInput } from "../../../processing/src/label/label-plan-model.js";
import { orderedFixture } from "../../../processing/src/label/ordered-fixture.js";
import {
  labelCandidate,
  visionFingerprint,
} from "../../../processing/src/testing/label-sources.js";
/* eslint-enable no-restricted-imports */
import { LabelWorkflow } from "./label-workflow.js";

const env = vi.hoisted(() => ({
  call: vi.fn(),
  warn: vi.fn(),
  states: new Map<string, unknown>(),
}));
vi.mock("@temporalio/workflow", async () => ({
  ...(await import("@temporalio/common")),
  patched: () => true,
  isCancellation: () => false,
  log: { info: vi.fn(), warn: env.warn },
  workflowInfo: () => ({ runId: "diagnostics-test" }),
}));
vi.mock("./label-stream.js", () => ({
  labelStream: () => ({ demand: true, finish: async () => true }),
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
vi.mock("./label-source.js", () => ({
  processSource: async (_work: unknown, source: { id: string }) => env.states.get(source.id),
}));

beforeEach(() => {
  env.call.mockReset();
  env.warn.mockClear();
  env.states.clear();
});
const signal = () => AbortSignal.timeout(5_000);
interface ReviewRequest {
  code: string;
  states: unknown[];
  primaryFailure?: { code: string };
  failures?: { sourceId: string; code: string }[];
}

async function setup(options: {
  policy: LabelPlanInput["failurePolicy"];
  pageHasLabelSection?: boolean;
}) {
  const fixture = await orderedFixture({
    order: "text-first",
    pageHasLabelSection: options.pageHasLabelSection ?? true,
  });
  fixture.input.failurePolicy = options.policy;
  alignPlanOwner(fixture);
  const files = new Map<string, Uint8Array>();
  fixture.plans.publish.mockImplementation(async (key: string, value: unknown) => {
    files.set(key, Buffer.from(JSON.stringify(value)));
  });
  const objects = { read: vi.fn(async (key: string) => files.get(key) ?? null) };
  const requests: ReviewRequest[] = [];
  const reviews = {
    review: async (raw: unknown) => {
      const request = raw as ReviewRequest & { input: { operationId: string } };
      requests.push(request);
      const code = request.primaryFailure?.code ?? request.code;
      return {
        status: "review",
        operationId: request.input.operationId,
        reviewId: "r",
        code,
        evidenceKey: "k",
        automaticRetry: false,
      };
    },
  };
  env.call.mockImplementation(async (_kind: string, name: string, request: unknown) => {
    if (name === "loadLabelPlan") {
      return fixture.loaded;
    }
    if (name === "inspectLabelImage") {
      return fixture.selection.inspect(request, signal());
    }
    if (name === "reviewLabelProduct") {
      return reviews.review(request);
    }
    throw new Error(`Unexpected activity ${name}`);
  });
  const run = () =>
    LabelWorkflow({ input: fixture.input, queues: { activities: "a", ocr: "o", model: "m" } });
  return { ...fixture, files, requests, objects, run };
}

/** The processing fixtures use a separate owner for their saved plan; the workflow verifies both. */
function alignPlanOwner(fixture: Awaited<ReturnType<typeof orderedFixture>>) {
  const owner = fixture.input.owner;
  for (const source of fixture.loaded.manifest.sources) {
    if (source.kind === "file-image") {
      Object.assign(source.plan.acquire, owner);
    } else if (source.kind === "page") {
      Object.assign(source.plan.page, owner);
      const { observationId, sourceId, listingId, variantId } = owner;
      Object.assign(source.plan.page.page, { observationId, sourceId, listingId, variantId });
    }
  }
}

function sourceReviews(fixture: Awaited<ReturnType<typeof setup>>) {
  const text = fixture.tasks.get("a-text");
  const image = fixture.tasks.get("source-0");
  if (text?.kind !== "text" || image?.kind !== "image") {
    throw new Error("Missing source fixture");
  }
  const candidate = labelCandidate();
  candidate.formula = null;
  candidate.otherIngredients = null;
  candidate.formulaComplete = false;
  candidate.ingredientsComplete = false;
  candidate.issues = [{ code: "FORMULA_MISSING", detail: "No label on the package front." }];
  const record = (imageReview: boolean): ReviewRecord =>
    ReviewRecordSchema.parse({
      schemaVersion: 1,
      reviewId: imageReview ? "no-label" : "text-failure",
      occurredAt: "2026-10-12T00:00:00.000Z",
      observation: fixture.input.owner,
      failure: {
        schemaVersion: 1,
        requestId: fixture.input.owner.requestId,
        observationId: fixture.input.owner.observationId,
        operationId: imageReview ? image.task.input.operationId : text.task.operationId,
        inputFingerprint: imageReview ? visionFingerprint(image.task) : text.task.inputFingerprint,
        stage: imageReview ? "codex.vision" : "codex.text",
        category: "PROCESSING",
        code: imageReview ? "CHANNEL.LABEL_NO_SOURCE" : "TEXT.CITATION_INVALID",
        executionFact: "executed",
        evidenceKey: imageReview ? "image/review.json" : "text/review.json",
        blockedBy: null,
        automaticRetry: false,
      },
      rawError: { name: "SourceFailure", message: "Source failed", stack: null, details: {} },
      candidate: imageReview ? { schema: "label-extraction/1", value: candidate } : null,
      inspection: { kind: "none" },
    });
  vi.mocked(fixture.inspection.review).mockImplementation(async (id) => record(id === "no-label"));
  env.states.set("a-text", { id: "a-text", status: "review", reviewId: "text-failure" });
  env.states.set("source-0", { id: "source-0", status: "review", reviewId: "no-label" });
  env.states.set("source-1", { id: "source-1", status: "not_matched" });
  const original = fixture.plans.source.getMockImplementation();
  if (!original) {
    throw new Error("Missing source reader");
  }
  fixture.plans.source.mockImplementation(async (request) =>
    request.sourceId === "source-1"
      ? { input: request, status: "not_matched", source: undefined }
      : original(request),
  );
}

it.each([
  ["source-failure-first/1", "CHANNEL.LABEL_NO_SOURCE"],
  ["source-failure-first/2", "TEXT.CITATION_INVALID"],
] as const)(
  "%s reaches the Review writer with %s, using the same workflow commands",
  async (policy, code) => {
    const fixture = await setup({ policy });
    sourceReviews(fixture);
    const result = await fixture.run();
    expect(env.warn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "review", code, automaticRetry: false });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.primaryFailure?.code ?? fixture.requests[0]?.code).toBe(code);
    expect(env.call.mock.calls.map(([kind, name]) => [kind, name])).toEqual([
      ["activities", "loadLabelPlan"],
      ["activities", "inspectLabelImage"],
      ["activities", "inspectLabelImage"],
      ["activities", "inspectLabelImage"],
      ["activities", "reviewLabelProduct"],
    ]);
  },
);

it("a true /2 no-source Review retains the bounded summary from the exact inspected prefix", async () => {
  const fixture = await setup({ policy: "source-failure-first/2", pageHasLabelSection: false });
  fixture.plans.source.mockImplementation(async (request) => ({
    input: request,
    status: "not_matched",
    source: undefined,
    ...(request.sourceId === "source-1" ? { reason: "no_text" } : {}),
  }));
  for (const id of ["source-0", "source-1"]) {
    env.states.set(id, { id, status: "not_matched" });
  }
  expect(await fixture.run()).toMatchObject({ status: "review", code: "CHANNEL.LABEL_NO_SOURCE" });
  const key = orderedProgressKey(fixture.input, [...env.states.values()]);
  const bytes = fixture.files.get(key);
  if (!bytes || fixture.requests.length !== 1) {
    throw new Error("Missing retained evidence");
  }
  const summary = {
    total: 3,
    omitted: 0,
    sources: [
      {
        sourceId: "a-text",
        kind: "page",
        status: "not_started",
        reason: "skipped",
        detail: "no_label_section",
      },
      {
        sourceId: "source-0",
        kind: "image",
        status: "not_matched",
        reason: "keyword_screen_missed",
        matchedKeywords: [],
      },
      {
        sourceId: "source-1",
        kind: "image",
        status: "not_matched",
        reason: "no_text",
        matchedKeywords: [],
      },
    ],
  };
  expect(decodeJson(bytes)).toMatchObject({ sourceOutcomes: summary });
  expect(JSON.stringify(summary).length).toBeLessThan(1_000);
});
