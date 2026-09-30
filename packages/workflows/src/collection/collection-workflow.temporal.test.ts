import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CollectionWorkflowInput } from "@crawl-automation/v3-contracts";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COLLECTION_WORKFLOW,
  MAX_READ_FAILURES,
  SCAN_MISSING,
  type CollectionScan,
} from "./collection-model.js";

const requestId = "44444444-4444-4444-8444-444444444444";
const sourceId = "33333333-3333-4333-8333-333333333333";
const scanId = "55555555-5555-4555-8555-555555555555";

const input: CollectionWorkflowInput = {
  version: 1,
  requestId,
  snapshot: {
    channel: "gnc",
    region: "US",
    url: "https://www.gnc.com/brands/nordic-naturals/",
    brandId: "22222222-2222-4222-8222-222222222222",
    brandName: "Nordic Naturals",
    sourceId,
    sourceRevision: 1,
  },
};

const scan = (state: CollectionScan["state"], queued: number | null = null): CollectionScan => ({
  scanId,
  state,
  queued,
  code: state === "review" ? "BRAND_SCAN.URL" : null,
});

let environment: TestWorkflowEnvironment;
let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;

beforeAll(async () => {
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./collection-workflow.ts", import.meta.url)),
  });
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

/** Runs one brand run against a fake scan table that answers the given sequence of reads. */
async function run(reads: Array<CollectionScan | Error>) {
  const taskQueue = `collection-${randomUUID()}`;
  const brandScanOf = vi.fn(async () => {
    const next = reads.length > 1 ? reads.shift() : reads[0];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    workflowBundle,
    taskQueue,
    activities: { brandScanOf },
  });
  const result = worker.runUntil(
    environment.client.workflow.execute(COLLECTION_WORKFLOW, {
      taskQueue,
      workflowId: `v3-collection-${randomUUID()}`,
      args: [input],
    }),
  );
  return { result, brandScanOf };
}

describe("CollectionWorkflow in Temporal", () => {
  it("waits while the brand scan runs and settles with what it queued", async () => {
    const { result, brandScanOf } = await run([
      scan("queued"),
      scan("running"),
      scan("complete", 48),
    ]);
    await expect(result).resolves.toEqual({
      codec: "collection-settled/1",
      requestId,
      scanId,
      state: "complete",
      queued: 48,
      code: null,
    });
    expect(brandScanOf).toHaveBeenCalledTimes(3);
    expect(brandScanOf).toHaveBeenCalledWith({ requestId, sourceId });
  }, 30_000);

  it("settles a scan that ended in Review, with its code", async () => {
    const { result } = await run([scan("review", 0)]);
    await expect(result).resolves.toMatchObject({ state: "review", code: "BRAND_SCAN.URL" });
  }, 30_000);

  it("rides out a failed read of the scan table", async () => {
    const { result, brandScanOf } = await run([
      ApplicationFailure.nonRetryable("database unavailable", "DATABASE.UNAVAILABLE"),
      scan("partial", 12),
    ]);
    await expect(result).resolves.toMatchObject({ state: "partial", queued: 12 });
    expect(brandScanOf).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("fails at once when the run has no scan, and after too many failed reads", async () => {
    const missing = await run([ApplicationFailure.nonRetryable("no scan", SCAN_MISSING)]);
    await expect(missing.result).rejects.toThrow();
    expect(missing.brandScanOf).toHaveBeenCalledTimes(1);
    const down = await run([ApplicationFailure.nonRetryable("down", "DATABASE.UNAVAILABLE")]);
    await expect(down.result).rejects.toThrow();
    expect(down.brandScanOf).toHaveBeenCalledTimes(MAX_READ_FAILURES);
  }, 60_000);
});
