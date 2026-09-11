import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { gncStreamFixture } from "../../../packages/v3-product/src/gnc-stream.fixture.js";

it("real Temporal: absent file worker and slow image do not block text/vision; replay, redelivery and cancellation are safe", async () => {
  if (!/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("Run runtime acceptance on Mac mini only");
  const f = await gncStreamFixture(), temporal = await TestWorkflowEnvironment.createLocal({ server: {
    ip: "127.0.0.1", ui: false, executable: { type: "cached-download", version: "v1.8.3" },
  } });
  const workers: Worker[] = [], running: Promise<void>[] = [];
  let release!: () => void; const slowImage = new Promise<void>(r => { release = r; });
  const bundle = { codePath: resolve("dist/label/product-workflows.cjs") };
  try {
    const queues = Object.fromEntries(Object.keys(f.route).map(k => [k, `stream-${k}`]));
    const launch = async (taskQueue: string, name?: string) => {
      const w = await Worker.create({ connection: temporal.nativeConnection, taskQueue,
        ...(name ? { activities: { [name]: (raw: unknown) => f.activities[name]!(raw) }, maxConcurrentActivityTaskExecutions: 1 }
          : { workflowBundle: bundle }) });
      workers.push(w); const run = w.run(); run.catch(() => {}); running.push(run); return w;
    };
    for (const [key, name] of Object.entries(f.route)) if (key !== "acquire") await launch(queues[key]!, name);
    await launch("stream-workflows");
    const start = (overrides: Record<string, string> = {}) => temporal.client.workflow.start("GncStreamingLabelWorkflow", {
      workflowId: `stream-${randomUUID()}`, taskQueue: "stream-workflows", workflowExecutionTimeout: "2 minutes",
      args: [{ input: f.input, start: "capture", queues: { ...queues, ...overrides } }],
    });
    const first = await start();
    await vi.waitFor(() => expect(f.textRegistry.data.size).toBe(1), { timeout: 20000 });
    expect(f.counts.download).toBe(0); expect(f.collected.size).toBe(0);
    const acquire = f.activities.acquireSourceFile!, assemble = vi.fn(f.activities.assembleLabelProduct!);
    f.activities.assembleLabelProduct = assemble;
    f.activities.acquireSourceFile = async raw => {
      const plan = await f.plans.inspect(f.input.sourcePlan, AbortSignal.timeout(10000));
      const second = plan!.manifest.sources.find(s => s.id === "image-1");
      if (second?.kind === "file-image" && second.plan.acquire.operationId === raw.operationId) await slowImage;
      return acquire(raw);
    };
    const fileWorker = await launch(queues.acquire!, "acquireSourceFile");
    await vi.waitFor(async () => {
      expect(f.visionRecords.size).toBe(1);
      expect(await first.query("gncStreamProgress")).toEqual({ expected: 3, finished: 2 });
    }, { timeout: 20000 });
    expect(f.counts.download).toBe(1); expect(assemble).not.toHaveBeenCalled();
    release();
    const out = await first.result(); expect(out).toMatchObject({ status: "collected" });
    expect(f.counts).toEqual({ capture: 1, download: 2, ocr: 2, text: 1, vision: 1 });
    expect(f.collected.size).toBe(1); expect(assemble).toHaveBeenCalledOnce();
    await Worker.runReplayHistory({ workflowBundle: bundle }, await first.fetchHistory(), first.workflowId);

    const puts = f.remote.writes, counts = { ...f.counts };
    const second = await start(); expect(await second.result()).toEqual(out);
    expect(f.counts).toEqual(counts); expect(f.remote.writes).toBe(puts); expect(f.collected.size).toBe(1);
    await Worker.runReplayHistory({ workflowBundle: bundle }, await second.fetchHistory(), second.workflowId);

    // No worker for this queue. Cancellation must not invent final Review or collect again.
    fileWorker.shutdown();
    const before = assemble.mock.calls.length, cancelled = await start({ acquire: "stream-unserved-file" });
    await vi.waitFor(async () => expect(await cancelled.query("gncStreamProgress")).toEqual({ expected: 3, finished: 1 }), { timeout: 20000 });
    await cancelled.cancel(); await expect(cancelled.result()).rejects.toThrow();
    expect((await cancelled.describe()).status.name).toBe("CANCELLED");
    expect(assemble).toHaveBeenCalledTimes(before); expect(f.counts).toEqual(counts); expect(f.remote.writes).toBe(puts);
    await Worker.runReplayHistory({ workflowBundle: bundle }, await cancelled.fetchHistory(), cancelled.workflowId);
  } finally {
    release(); for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
    await Promise.allSettled(running); await temporal.teardown();
  }
}, 120000);
