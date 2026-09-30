import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { GNC_QUEUES, GNC_DISCOVERY_QUEUE, GNC_CATALOG_PAGE_QUEUE, type GncAcquireInput, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { GncAdapter, GncCaptureEvidence, AcquireGncModule, ResolveGncReceipt, GncCatalogDiscoveries, gncDiscoveryKey } from "@crawl-automation/v3-channels";
import { MemoryObjects } from "../../../packages/v3-results/src/testing.fixture.js";

it("real Temporal: missing discovery worker frees capture; first publication survives a later Review and replay", async () => {
  const temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
    executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI }
      : { type: "cached-download", version: "v1.8.3" } } });
  const workers: Worker[] = [], running: Promise<void>[] = [], records = new Map<string, ReviewRecord>();
  const local = new MemoryObjects(), remote = new MemoryObjects();
  const reviews = { append: async (r: ReviewRecord) => { records.set(r.reviewId, r); }, read: async (id: string) => records.get(id) ?? null };
  const evidence = new GncCaptureEvidence({ local, remote, reviews });
  const task: GncAcquireInput = { schemaVersion: 1, implementationVersion: "gnc-acquire/1",
    owner: { schemaVersion: 1, requestId: "req", observationId: "obs", brandId: "brand", sourceId: "gnc", listingId: "catalog", variantId: null },
    capture: { kind: "catalog-page", requestId: "req", operationId: "catalog", brandId: "brand", sourceId: "gnc",
      binding: { sessionId: "s", egressId: "host/1" }, url: "https://www.gnc.com/brands/example/" },
    network: { routeId: "r", version: "1", mode: "host", managed: false, egressId: "host/1" } };
  const read = vi.fn(async (capture: GncAcquireInput["capture"]) => ({ operationId: capture.operationId, requestedUrl: capture.url, finalUrl: capture.url,
    binding: capture.binding, network: task.network, status: 200, contentType: "text/html", bytes: Buffer.from(
      '<div class="product-tile"><a href="/123456.html">One</a></div><div class="product-tile"><a href="/123457.html">Two</a></div>') }));
  const acquisition = new AcquireGncModule(evidence, new GncAdapter({ read }));
  const receipt = new ResolveGncReceipt(evidence), discoveries = new GncCatalogDiscoveries(evidence);
  const signal = () => AbortSignal.timeout(10000);
  const launch = async (queue: string, activities?: Record<string, (...args: any[]) => Promise<unknown>>) => {
    const worker = await Worker.create({ connection: temporal.nativeConnection, taskQueue: queue,
      ...(activities ? { activities, maxConcurrentActivityTaskExecutions: 1 }
        : { workflowBundle: { codePath: resolve("dist/gnc/gnc-workflows.cjs") } }) });
    workers.push(worker); const run = worker.run(); run.catch(() => {}); running.push(run);
  };
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  try {
    await launch(GNC_QUEUES.workflow); await launch(GNC_CATALOG_PAGE_QUEUE);
    await launch(GNC_QUEUES.catalog, { captureGncCatalog: input => acquisition.run(input, signal()) });
    await launch(GNC_QUEUES.receipt, { resolveGncReceipt: input => receipt.run(input, signal()) });
    const first = await temporal.client.workflow.start("GncCatalogPageWorkflow", { taskQueue: GNC_CATALOG_PAGE_QUEUE,
      workflowId: `discovery-${randomUUID()}`, args: [{ task }], workflowExecutionTimeout: "1 minute" });
    await vi.waitFor(async () => expect(await evidence.inspect(task, signal())).not.toBeNull(), { timeout: 15000 });
    // Discovery has no worker yet. The browser/capture queue must still accept another page.
    const second = { ...task, capture: { ...task.capture, operationId: "catalog-second" } };
    expect(await temporal.client.workflow.execute("GncCaptureWorkflow", { taskQueue: GNC_QUEUES.workflow,
      workflowId: `capture-${randomUUID()}`, args: [{ task: second }], workflowExecutionTimeout: "1 minute" })).toMatchObject({ status: "durable" });
    expect(read).toHaveBeenCalledTimes(2);
    const secondKey = gncDiscoveryKey({ task, index: 1 }), create = remote.create.bind(remote);
    const writes = vi.spyOn(remote, "create").mockImplementation(async (...args) => { if (args[0] === secondKey) throw Error("synthetic publication failure"); return create(...args); });
    await launch(GNC_DISCOVERY_QUEUE, { publishGncDiscovery: async input => { if (input.index === 1) await gate; return discoveries.run(input, signal()); } });
    await vi.waitFor(async () => expect(await discoveries.inspect({ task, index: 0 }, signal())).not.toBeNull(), { timeout: 15000 });
    expect(remote.data.has(secondKey)).toBe(false); // First entry is visible before page workflow ends.
    release();
    expect(await first.result()).toMatchObject({ status: "review", published: 1, reviewed: 1, brandComplete: false });
    const puts = writes.mock.calls.length;
    await Worker.runReplayHistory({ workflowBundle: { codePath: resolve("dist/gnc/gnc-workflows.cjs") } }, await first.fetchHistory(), first.workflowId);
    const cold = new GncCatalogDiscoveries(new GncCaptureEvidence({ local: new MemoryObjects(), remote, reviews }));
    expect(await cold.run({ task, index: 0 }, signal())).toMatchObject({ status: "published" });
    expect(await cold.run({ task, index: 1 }, signal())).toMatchObject({ status: "review", code: "GNC.DISCOVERY_HANDOFF_PENDING" });
    expect(writes).toHaveBeenCalledTimes(puts); expect(read).toHaveBeenCalledTimes(2);
  } finally {
    release(); for (const worker of workers) worker.shutdown();
    await Promise.allSettled(running); await temporal.teardown();
  }
}, 60000);
