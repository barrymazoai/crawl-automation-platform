import { beforeEach, expect, it, vi } from "vitest";
const environment = vi.hoisted(() => ({
  handlers: new Map<string, (value: unknown) => void>(),
  signal: vi.fn(),
}));
vi.mock("@temporalio/workflow", async () => ({
  ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure,
  defineSignal: (name: string) => name,
  setHandler: (name: string, handler: (value: unknown) => void) =>
    environment.handlers.set(name, handler),
  condition: async (predicate: () => boolean) =>
    vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 1000, interval: 1 }),
  workflowInfo: () => ({ parent: { workflowId: "parent", runId: "parent-run" } }),
  getExternalWorkflowHandle: () => ({ signal: environment.signal }),
  log: { warn: vi.fn() },
}));
import { demandFeed } from "./label-demand-feed.js";
import { labelStream } from "./label-stream.js";
import { LabelTaskSchema } from "./label-model.js";
import { task } from "./label-fixture.js";
import { pipelineFixture } from "../testing/replay/product-fixture.js";
import type { LabelStep } from "../stream-label.js";

beforeEach(() => {
  environment.handlers.clear();
  environment.signal.mockReset().mockImplementation(async (name: string, value: unknown) => {
    environment.handlers.get(name)?.(value);
  });
});

async function fixture() {
  const pipeline = pipelineFixture("queue");
  const planned = await pipeline.activities.prepareChannelProduct();
  if (planned.status !== "prepared") {
    throw new Error("Missing prepared fixture");
  }
  const source = planned.manifest.sources[0];
  if (source?.kind !== "file-image") {
    throw new Error("Missing image fixture");
  }
  const acquire = vi.fn(pipeline.activities.acquireProductFile);
  const step = {
    input: pipeline.input,
    sourcePlan: (await pipeline.activities.captureProduct()).sourcePlan,
    manifest: { ...planned.manifest, sources: [source, { ...source, id: "unused-image" }] },
    pipeline: { ...pipeline.activities, acquireProductFile: acquire },
  } as unknown as LabelStep;
  const feed = demandFeed(step, task.operationId);
  const stream = labelStream(LabelTaskSchema.parse(task), true);
  const child = { result: () => new Promise<unknown>(() => {}), signal: environment.signal };
  const feeding = feed(child as unknown as Parameters<typeof feed>[0]).then(() => {
    environment.handlers.get("labelStreamSealed")?.({
      operationId: task.operationId,
      status: "closed",
    });
  });
  return { stream, source, acquire, feeding };
}

it("downloads only requested images and deduplicates the request, then closes without waiting for fallback", async () => {
  const test = await fixture();
  expect(test.acquire).not.toHaveBeenCalled();
  expect(await test.stream.ready(test.source)).toBe(true);
  expect(await test.stream.ready(test.source)).toBe(true);
  expect(test.acquire).toHaveBeenCalledOnce();
  expect(await test.stream.finish()).toBe(true);
  await test.feeding;
  expect(test.acquire).toHaveBeenCalledOnce();
});

it("a complete text source closes the feed with zero image downloads", async () => {
  const test = await fixture();
  expect(await test.stream.finish()).toBe(true);
  await test.feeding;
  expect(test.acquire).not.toHaveBeenCalled();
});

it("delivers a failed download as source evidence instead of overriding the label Review", async () => {
  const test = await fixture();
  test.acquire.mockResolvedValue({
    status: "review",
    operationId: test.source.plan.acquire.operationId,
    reviewId: "file-review",
    code: "FILE.TIMEOUT",
    evidenceKey: "files/review.json",
    automaticRetry: false,
  } as never);
  expect(await test.stream.ready(test.source)).toBe(false);
  expect(test.stream.failure?.(test.source)).toEqual({
    id: test.source.id,
    status: "review",
    reviewId: "file-review",
  });
  expect(await test.stream.finish()).toBe(true);
  await test.feeding;
  expect(test.acquire).toHaveBeenCalledOnce();
});

it("rejects an unplanned request before admitting a download", async () => {
  const test = await fixture();
  environment.handlers.get("labelSourceRequested")?.({
    operationId: task.operationId,
    sourceId: "foreign",
  });
  await expect(test.feeding).rejects.toMatchObject({ type: "CHANNEL.LABEL_IDENTITY_CONFLICT" });
  expect(test.acquire).not.toHaveBeenCalled();
});
