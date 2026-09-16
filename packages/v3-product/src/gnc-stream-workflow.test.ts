import { beforeEach, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ activities: {} as Record<string, Record<string, (raw: any) => Promise<any>>>, query: null as null | (() => unknown) }));
vi.mock("@temporalio/workflow", () => ({
  patched: () => true,
  proxyActivities: ({ taskQueue }: { taskQueue: string }) => runtime.activities[taskQueue],
  isCancellation: (e: unknown) => e instanceof Error && e.message === "cancelled",
  defineQuery: (name: string) => name, setHandler: (_query: unknown, handler: () => unknown) => { runtime.query = handler; },
  ApplicationFailure: class extends Error { constructor(message: string, readonly type: string) { super(message); }
    static nonRetryable(message: string, type: string) { return new this(message, type); } },
}));
import { GncStreamingLabelWorkflow } from "./gnc-stream-workflow.js";
import { gncStreamFixture } from "./gnc-stream.fixture.js";
import { ResolveAcquiredFile } from "../../v3-acquisition/src/handoff.js";
beforeEach(() => { runtime.activities = {}; runtime.query = null; });
const gate = () => { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; };
async function setup(core = false) {
  const f = await gncStreamFixture(core);
  for (const [queue, name] of Object.entries(f.route)) { f.activities[name] = vi.fn(f.activities[name]!); runtime.activities[queue] = { [name]: raw => f.activities[name]!(raw) }; }
  return { ...f, entry: { input: f.input, start: "capture", queues: f.queues } };
}
it("slow second image does not block page text or first image vision; only final join waits", async () => {
  const f = await setup(), slow = gate(), original = f.activities.acquireSourceFile!;
  f.activities.acquireSourceFile = vi.fn(async raw => {
    const plan = await f.plans.inspect(f.input.sourcePlan, new AbortController().signal);
    const s = plan!.manifest.sources.find(s => s.id === "image-1");
    if (s?.kind === "file-image" && s.plan.acquire.operationId === raw.operationId) await slow.wait;
    return original(raw);
  });
  const run = GncStreamingLabelWorkflow(f.entry);
  // A registry write precedes its verified activity completion; wait for both observable facts.
  await vi.waitFor(() => { expect(f.textRegistry.data.size).toBe(1); expect(f.visionRecords.size).toBe(1);
    expect(runtime.query!()).toEqual({ expected: 3, finished: 2 }); }, { timeout: 10000 });
  expect(f.counts.download).toBe(1); expect(f.activities.assembleLabelProduct).not.toHaveBeenCalled();
  expect(runtime.query!()).toEqual({ expected: 3, finished: 2 }); slow.release();
  expect(await run).toMatchObject({ status: "collected" }); expect(f.counts).toEqual({ capture: 1, download: 2, ocr: 2, text: 1, vision: 1 });
});
it("core preparation runs independently and normal GNC flow collects with packaging warnings", async () => {
  const f = await setup(true);
  const out = await GncStreamingLabelWorkflow(f.entry);
  expect(out, JSON.stringify([...f.reviews.records.values()].map(r => r.failure.code))).toMatchObject({ status: "collected" });
  expect(f.activities.prepareLabelCore).toHaveBeenCalledTimes(1);
  const record = [...f.collected.values()][0]!;
  expect(record).toMatchObject({ schemaVersion: 4, comparisonPolicy: "label-typography/2", formula: { servingsPerContainer: null } });
  expect(record.warnings.some(w => w.code === "PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT")).toBe(true);
  const task = [...f.textRegistry.data.values()][0]!.input;
  expect(task.source.kind === "prepared" && task.source.document.producer.module).toBe("label.core.prepare");
  const puts = f.remote.writes, counts = { ...f.counts };
  expect(await GncStreamingLabelWorkflow(f.entry)).toMatchObject({ status: "collected" });
  expect(f.remote.writes).toBe(puts); expect(f.counts).toEqual(counts);
});
it("waiting for core preparation never occupies or blocks the image pipeline", async () => {
  const f = await setup(true), slow = gate(), original = f.activities.prepareLabelCore!;
  f.activities.prepareLabelCore = vi.fn(async raw => { await slow.wait; return original(raw); });
  const run = GncStreamingLabelWorkflow(f.entry);
  await vi.waitFor(() => expect(f.visionRecords.size).toBe(1), { timeout: 10000 });
  expect(f.counts.text).toBe(0); expect(f.activities.assembleLabelProduct).not.toHaveBeenCalled();
  slow.release(); expect(await run).toMatchObject({ status: "collected" });
});
it.each(["missing", "lost-receipt", "foreign-receipt"])("core %s cannot trigger text or collect; other images still finish", async mode => {
  const f = await setup(true), original = f.activities.prepareLabelCore!;
  f.activities.prepareLabelCore = vi.fn(async raw => {
    if (mode === "missing") throw Error("unavailable");
    const out = await original(raw);
    if (mode === "lost-receipt") throw Error("ack lost");
    return { ...out, input: { ...out.input, owner: { ...out.input.owner, listingId: "foreign" } } };
  });
  expect(await GncStreamingLabelWorkflow(f.entry)).toMatchObject({ status: "review" });
  expect(f.counts.text).toBe(0); expect(f.counts.vision).toBe(1); expect(f.collected.size).toBe(0);
  expect(f.activities.prepareLabelCore).toHaveBeenCalledTimes(1);
});
it("core policy and queue require explicit pairing before any dispatch", async () => {
  const f = await setup(true), { core, ...queues } = f.queues;
  await expect(GncStreamingLabelWorkflow({ ...f.entry, queues })).rejects.toThrow("Invalid GNC streaming input");
  expect(f.counts.capture).toBe(0);
});
it("slow text does not block independent image pipelines", async () => {
  const f = await setup(), slow = gate(), original = f.activities.interpretText!;
  f.activities.interpretText = vi.fn(async raw => { await slow.wait; return original(raw); });
  const run = GncStreamingLabelWorkflow(f.entry);
  await vi.waitFor(() => expect(f.visionRecords.size).toBe(1), { timeout: 10000 }); expect(f.counts.text).toBe(0);
  expect(f.activities.assembleLabelProduct).not.toHaveBeenCalled(); slow.release(); expect(await run).toMatchObject({ status: "collected" });
});
it("a failed file stays Review but does not cancel the page or other image", async () => {
  const f = await setup(), original = f.activities.acquireSourceFile!;
  f.activities.acquireSourceFile = vi.fn(async raw => {
    const plan = await f.plans.inspect(f.input.sourcePlan, new AbortController().signal), s = plan!.manifest.sources.find(s => s.id === "image-1");
    return s?.kind === "file-image" && s.plan.acquire.operationId === raw.operationId ? f.fileEvidence.review(raw, "file.acquire", Error("SOURCE.NETWORK_UNAVAILABLE")) : original(raw);
  });
  expect(await GncStreamingLabelWorkflow(f.entry)).toMatchObject({ status: "review", automaticRetry: false });
  expect(f.textRegistry.data.size).toBe(1); expect(f.visionRecords.size).toBe(1); expect(f.collected.size).toBe(0);
  expect([...f.reviews.records.values()].some(r => r.failure.code === "SOURCE.NETWORK_UNAVAILABLE")).toBe(true);
});
it("full re-execution of the same operations uses evidence without new capture/download/OCR/models/PUTs", async () => {
  const f = await setup(), out = await GncStreamingLabelWorkflow(f.entry); expect(out, JSON.stringify([...f.reviews.records.values()])).toMatchObject({ status: "collected" });
  const counts = { ...f.counts }, puts = f.remote.writes;
  expect(await GncStreamingLabelWorkflow(f.entry)).toEqual(out); expect(f.counts).toEqual(counts); expect(f.remote.writes).toBe(puts);
});
it("a forged per-source image receipt cannot trigger a model or be silently excluded", async () => {
  const f = await setup(), original = f.activities.prepareGncLabelSource!;
  f.activities.prepareGncLabelSource = vi.fn(async raw => { const r = await original(raw);
    if (r.status === "prepared" && r.source.kind === "image") r.source.task.input.selection.image.artifactId = "foreign-image"; return r; });
  expect(await GncStreamingLabelWorkflow(f.entry)).toMatchObject({ status: "review" });
  expect(f.counts.vision).toBe(0); expect(f.counts.text).toBe(1); expect(f.collected.size).toBe(0);
});
it("unknown single-source response never causes another source activity or model retry", async () => {
  const f = await setup(), original = f.activities.prepareGncLabelSource!;
  f.activities.prepareGncLabelSource = vi.fn(async raw => { const r = await original(raw); if (raw.sourceId === "image-0") throw Error("lost response"); return r; });
  expect(await GncStreamingLabelWorkflow(f.entry)).toMatchObject({ status: "review" });
  expect(f.activities.prepareGncLabelSource).toHaveBeenCalledTimes(3); expect(f.counts.vision).toBe(0); expect(f.counts.ocr).toBe(2);
});
it("incomplete final source coverage fails explicitly before collection", async () => {
  const f = await setup(), original = f.activities.prepareGncLabel!;
  f.activities.prepareGncLabel = vi.fn(async raw => { const r = await original(raw); if (r.status === "prepared") r.skipped = []; return r; });
  await expect(GncStreamingLabelWorkflow(f.entry)).rejects.toThrow("Incomplete final source coverage"); expect(f.activities.collectLabelProduct).not.toHaveBeenCalled();
});
it("cancel before preparation never dispatches processing or final reconciliation", async () => {
  const f = await setup(); f.activities.loadGncLabelPlan = vi.fn(async () => { throw Error("cancelled"); });
  await expect(GncStreamingLabelWorkflow({ ...f.entry, start: "saved-plan" })).rejects.toThrow("cancelled");
  expect(f.activities.prepareGncLabel).not.toHaveBeenCalled(); expect(f.counts).toEqual({ capture: 0, download: 0, ocr: 0, text: 0, vision: 0 });
});
it("capture mode requires explicit queues; saved-plan mode does not recapture", async () => {
  const f = await setup(), { capture, ...queues } = f.queues;
  await expect(GncStreamingLabelWorkflow({ ...f.entry, queues })).rejects.toThrow("Invalid GNC streaming input"); expect(f.counts.capture).toBe(0);
  await f.activities.captureGncProduct!(f.input.sourcePlan.task);
  await f.activities.prepareGncProduct!({ input: f.input.sourcePlan, receipt: null });
  expect(await GncStreamingLabelWorkflow({ ...f.entry, start: "saved-plan", queues })).toMatchObject({ status: "collected" }); expect(f.counts.capture).toBe(1);
});
it.each([false, true])("saved core plan uses receipt-only files; missing evidence=%s never downloads or retries providers", async missing => {
  const f = await setup(true);
  await f.activities.captureGncProduct!(f.input.sourcePlan.task);
  await f.activities.prepareGncProduct!({ input: f.input.sourcePlan, receipt: null });
  const plan = (await f.plans.inspect(f.input.sourcePlan, new AbortController().signal))!;
  for (const source of plan.manifest.sources) if (source.kind === "file-image") {
    if (!missing || source.id !== "image-1") await f.activities.acquireSourceFile!(source.plan.acquire);
  }
  const before = { ...f.counts }, receipt = new ResolveAcquiredFile(f.fileEvidence);
  f.activities.acquireSourceFile = vi.fn(raw => receipt.run(raw, new AbortController().signal));
  const out = await GncStreamingLabelWorkflow({ ...f.entry, start: "saved-plan" });
  expect(out.status).toBe(missing ? "review" : "collected");
  expect(f.counts.capture).toBe(before.capture); expect(f.counts.download).toBe(before.download);
  expect(f.counts.text).toBe(1); expect(f.counts.vision).toBe(1);
  expect(f.activities.acquireSourceFile).toHaveBeenCalledTimes(2);
  if (missing) { expect(f.collected.size).toBe(0); expect(f.counts.ocr).toBe(1); }
});
