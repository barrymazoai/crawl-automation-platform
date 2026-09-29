import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { swansonLiveFixture } from "@crawl-automation/v3-channels/testing/swanson-live";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ProductPipelineInput } from "@crawl-automation/workflows";
import type { SharedLabelSettings } from "./label-handoffs.js";
import { describe, expect, it, vi } from "vitest";
import { LabelReviews } from "./label-reviews.js";
import { LabelTasks } from "./label-tasks.js";

const signal = () => AbortSignal.timeout(5000);

const pipeline: ProductPipelineInput = {
  codec: "product-pipeline/1",
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "swanson",
  url: "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-capture-1",
  queues: { activities: "pipeline", plan: "pipeline", label: "label" },
  resources: { queue: "resource", activities: {}, maxWaitSeconds: 900 },
};

const shared = { queues: { activities: "label", ocr: "label-ocr", model: "label-model" } };

async function setup(
  options: { planned?: unknown; withShared?: boolean; shared?: SharedLabelSettings } = {},
) {
  const fixture = swansonLiveFixture();
  const { sourcePlan } = await fixture.live.capture(await fixture.job(), signal());
  const saved = new Map<string, Uint8Array>();
  const evidence = {
    publish: vi.fn(async (key: string, bytes: Uint8Array) => void saved.set(key, bytes)),
  };
  const executions = { register: vi.fn(async () => undefined) };
  const tasks = new LabelTasks({
    registry: new ChannelRegistry([swansonAdapter]),
    plans: { inspect: async () => ("planned" in options ? options.planned : { manifest: {} }) },
    evidence,
    executions,
    settings: {
      text: {
        ...fixture.settings.text,
        resultSchemaVersion: 3,
        implementationVersion: "codex-text/3",
        policyVersion: "label-text/4",
      },
      visionConfigFingerprint: "d".repeat(64),
      evidencePolicy: "label-image-first/5",
      queues: {} as never,
      resources: { queue: "resource", activities: {}, maxWaitSeconds: 900 },
      ...(options.withShared === false ? {} : { shared: options.shared ?? shared }),
    },
  });
  const execution = { clusterId: "c", namespace: "n", workflowId: "w", runId: "r" };
  return { tasks, sourcePlan, saved, executions, execution };
}

describe("LabelTasks", () => {
  it("builds the shared label task from the channel's plan, with its core policy, keeps it and links the run", async () => {
    const { tasks, sourcePlan, saved, executions, execution } = await setup();

    const task = await tasks.prepare({ pipeline, sourcePlan, execution }, signal());

    expect(task.queues).toEqual(shared.queues);
    expect(task.input).toMatchObject({
      owner: sourcePlan.owner,
      plan: {
        operationId: sourcePlan.operationId,
        sourceOperationId: sourcePlan.source.producer.operationId,
      },
      corePolicy: "swanson-label-core/1",
      evidencePolicy: "label-image-first/5",
    });
    expect(task.input.plan.input).toEqual(sourcePlan);
    expect(saved.has("v3/product-runs/pipeline-capture-1/label-task.json")).toBe(true);
    expect(executions.register).toHaveBeenCalledWith(sourcePlan.owner.observationId, execution);
  });

  it("label permits release on a Review, with no review-stop check (the worker hosts no stop verifier)", async () => {
    const needs = [{ resourceId: "mini-model-account", units: 1 }];
    const resources = {
      queue: "resource",
      reviewStopCheck: true,
      activities: { interpretText: needs },
      maxWaitSeconds: 900,
    };
    const { tasks, sourcePlan, execution } = await setup({ shared: { ...shared, resources } });

    const task = await tasks.prepare({ pipeline, sourcePlan, execution }, signal());

    expect(task.resources).toEqual({
      queue: "resource",
      releaseOnReview: true,
      activities: { interpretText: needs },
      maxWaitSeconds: 900,
    });
  });

  it("refuses without the shared workflow's settings, and without a saved plan", async () => {
    const unset = await setup({ withShared: false });
    await expect(
      unset.tasks.prepare(
        { pipeline, sourcePlan: unset.sourcePlan, execution: unset.execution },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "PIPELINE.LABEL_SETTINGS_MISSING" });
    const unplanned = await setup({ planned: null });
    await expect(
      unplanned.tasks.prepare(
        { pipeline, sourcePlan: unplanned.sourcePlan, execution: unplanned.execution },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "PIPELINE.PLAN_UNVERIFIED" });
  });
});

describe("LabelReviews", () => {
  it("records one Review per label task with every source's state, and answers the same one again", async () => {
    const { tasks, sourcePlan, execution } = await setup();
    const { input } = await tasks.prepare({ pipeline, sourcePlan, execution }, signal());
    const rows = new Map<string, ReviewRecord>();
    const reviews = {
      read: vi.fn(async (id: string) => rows.get(id) ?? null),
      append: vi.fn(async (record: ReviewRecord) => rows.set(record.reviewId, record)),
    };
    const service = new LabelReviews({
      evidence: { publish: vi.fn(async () => undefined) },
      reviews,
    });
    const request = {
      input,
      code: "CHANNEL.DEPENDENCY_UNAVAILABLE",
      states: [{ id: "page", status: "unresolved" }],
      failures: [{ sourceId: "page", code: "RESOURCE.WAIT_LIMIT", executionFact: "not_executed" }],
    };

    const first = await service.review(request, signal());
    const second = await service.review(request, signal());

    expect(first).toMatchObject({
      status: "review",
      operationId: input.operationId,
      code: "CHANNEL.DEPENDENCY_UNAVAILABLE",
    });
    expect(second).toEqual(first);
    expect(reviews.append).toHaveBeenCalledOnce();
    expect(reviews.append.mock.calls[0]?.[0].rawError.details).toMatchObject({
      failures: request.failures,
    });
  });
});
