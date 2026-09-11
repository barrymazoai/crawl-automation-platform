import { beforeEach, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ activities: {} as Record<string, Record<string, (...args: any[]) => Promise<unknown>>> }));
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: ({ taskQueue }: { taskQueue: string }) => runtime.activities[taskQueue],
  isCancellation: (e: unknown) => e instanceof Error && e.message === "cancelled",
  ApplicationFailure: class extends Error { constructor(message: string, readonly type: string) { super(message); }
    static nonRetryable(message: string, type: string) { return new this(message, type); } },
}));
import { LabelProductWorkflow } from "./label-workflow.js";
import { GncPreparedLabelWorkflow } from "./gnc-label-workflow.js";
import { GncLabelInputSchema } from "@crawl-automation/v3-contracts";
import { LabelProductJoinSchema } from "@crawl-automation/v3-contracts";
import { observation, selection } from "../../v3-vision/src/testing.fixture.js";
beforeEach(() => { runtime.activities = {}; });
async function setup() {
  const f = { join: LabelProductJoinSchema.parse({ manifest: { operationId: "label-product", observation,
    sources: [0, 1].map(index => ({ id: `source-${index}`, kind: "image", required: true,
      task: { configFingerprint: "a".repeat(64), input: { operationId: `label-source-${index}`, selection: selection(), extractionProtocol: "label-extraction/1" } } })) },
    states: [0, 1].map(index => ({ id: `source-${index}`, status: "registered" })) }) };
  const key = `v3/label-products/${f.join.manifest.operationId}/assembly.json`;
  const saved = { status: "collected", operationId: f.join.manifest.operationId, observationId: f.join.manifest.observation.observationId, evidenceKey: key, recordHash: "a".repeat(64) };
  const vision = vi.fn(async (task: any): Promise<unknown> => ({ status: "registered", operationId: task.input.operationId }));
  const assembly = vi.fn(async (_join: unknown): Promise<unknown> => ({ status: "ready", evidenceKey: key }));
  const collection = vi.fn(async (): Promise<unknown> => saved);
  runtime.activities = { vision: { interpretImage: vision }, assembly: { assembleLabelProduct: assembly }, collection: { collectLabelProduct: collection } };
  return { ...f, key, saved, vision, assembly, collection, plan: { manifest: f.join.manifest,
    queues: { text: "text", textReceipts: "receipts", vision: "vision", assembly: "assembly", collection: "collection" } } };
}
it("starts sibling sources concurrently and joins only after the terminal barrier", async () => {
  const f = await setup(); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  f.vision.mockImplementation(async task => { if (task.input.operationId === "label-source-0") await gate; return { status: "registered", operationId: task.input.operationId }; });
  const promise = LabelProductWorkflow(f.plan);
  await vi.waitFor(() => expect(f.vision).toHaveBeenCalledTimes(2)); expect(f.assembly).not.toHaveBeenCalled();
  release(); expect(await promise).toEqual(f.saved); expect(f.assembly).toHaveBeenCalledOnce(); expect(f.collection).toHaveBeenCalledOnce();
});
it("unknown execution is reconciled from evidence without executing again", async () => {
  const f = await setup(); f.vision.mockRejectedValueOnce(Error("lost response"));
  await LabelProductWorkflow(f.plan); expect(f.vision).toHaveBeenCalledTimes(2);
  expect(f.assembly.mock.calls[0]![0]).toMatchObject({ states: [{ id: "source-0", status: "unresolved" }, { id: "source-1", status: "registered" }] });
});
it("keeps upstream Review, completes sibling, and skips collection", async () => {
  const f = await setup(); f.vision.mockResolvedValueOnce({ status: "review", reviewId: "upstream-review" });
  const review = { status: "review", reviewId: "assembled-review", evidenceKey: f.key, codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"], automaticRetry: false };
  f.assembly.mockResolvedValue(review); expect(await LabelProductWorkflow(f.plan)).toEqual(review);
  expect(f.vision).toHaveBeenCalledTimes(2); expect(f.collection).not.toHaveBeenCalled();
  expect(f.assembly.mock.calls[0]![0]).toMatchObject({ states: [{ id: "source-0", status: "review", reviewId: "upstream-review" }, { id: "source-1", status: "registered" }] });
});
it.each([{ status: "registered", operationId: "foreign" }, { status: "review", reviewId: "" }])("rejects malformed/foreign receipt even for an optional source: %j", async receipt => {
  const f = await setup(); f.plan.manifest.sources[0]!.required = false; f.vision.mockResolvedValueOnce(receipt);
  await LabelProductWorkflow(f.plan);
  expect(f.assembly.mock.calls[0]![0]).toMatchObject({ states: [{ id: "source-0", status: "rejected" }, { id: "source-1", status: "registered" }] });
});
it("cancellation never dispatches assembly or collection", async () => {
  const f = await setup(); f.vision.mockRejectedValueOnce(Error("cancelled"));
  await expect(LabelProductWorkflow(f.plan)).rejects.toThrow("cancelled"); expect(f.assembly).not.toHaveBeenCalled(); expect(f.collection).not.toHaveBeenCalled();
});
it("rejects invalid manifests and mismatched downstream receipts explicitly", async () => {
  const f = await setup(); await expect(LabelProductWorkflow({})).rejects.toThrow("Invalid label manifest");
  f.assembly.mockResolvedValue({ status: "ready", evidenceKey: "foreign/assembly.json" });
  await expect(LabelProductWorkflow(f.plan)).rejects.toThrow("Wrong label receipt"); expect(f.collection).not.toHaveBeenCalled();
  f.assembly.mockResolvedValue({ status: "ready", evidenceKey: f.key }); f.collection.mockResolvedValue({ ...f.saved, operationId: "foreign" });
  await expect(LabelProductWorkflow(f.plan)).rejects.toThrow("Invalid label collection");
});
async function gncSetup() {
  const f = await setup(), owner = f.plan.manifest.observation;
  const input = GncLabelInputSchema.parse({ operationId: f.plan.manifest.operationId,
    sourcePlan: { operationId: "source-plan", task: { schemaVersion: 1, implementationVersion: "gnc-acquire/1", owner,
      capture: { kind: "product", requestId: owner.requestId, operationId: "capture", brandId: owner.brandId, sourceId: owner.sourceId,
        url: "https://www.gnc.com/123456.html", sku: "123456", binding: { sessionId: "fixture", egressId: "direct/1" } },
      network: { routeId: "fixture", version: "1", egressId: "direct/1", mode: "direct", managed: true } },
      text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2, configFingerprint: "a".repeat(64) },
      ocr: { schemaVersion: 1, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) }, visionConfigFingerprint: "c".repeat(64) },
    text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/3", policyVersion: "label-text/1", resultSchemaVersion: 3, configFingerprint: "d".repeat(64) }, visionConfigFingerprint: "e".repeat(64) });
  const receipt = { status: "prepared", input, evidenceKey: `v3/gnc-label-inputs/${input.operationId}/manifest.json`, manifest: f.plan.manifest, skipped: [] };
  const prepare = vi.fn(async (): Promise<unknown> => receipt); runtime.activities.prepare = { prepareGncLabel: prepare };
  return { ...f, input, receipt, prepare, entry: { input, queues: { ...f.plan.queues, prepare: "prepare" } } };
}
it("prepared GNC entry hands the manifest to concurrent new-protocol processing and collection", async () => {
  const f = await gncSetup(); expect(await GncPreparedLabelWorkflow(f.entry)).toEqual(f.saved);
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.vision).toHaveBeenCalledTimes(2); expect(f.collection).toHaveBeenCalledOnce();
});
it("prepared GNC Review stops before model activities", async () => {
  const f = await gncSetup(), review = { status: "review", operationId: f.input.operationId, reviewId: "upstream", code: "GNC.LABEL_PREPARATION_UNVERIFIED", automaticRetry: false };
  f.prepare.mockResolvedValue(review); expect(await GncPreparedLabelWorkflow(f.entry)).toEqual(review);
  expect(f.vision).not.toHaveBeenCalled(); expect(f.collection).not.toHaveBeenCalled();
});
it("prepared GNC foreign receipt and invalid input fail explicitly without scheduling models", async () => {
  const f = await gncSetup(); await expect(GncPreparedLabelWorkflow({})).rejects.toThrow("Invalid prepared GNC label input");
  f.prepare.mockResolvedValue({ ...f.receipt, evidenceKey: "foreign/manifest.json" });
  await expect(GncPreparedLabelWorkflow(f.entry)).rejects.toThrow("Foreign label preparation"); expect(f.vision).not.toHaveBeenCalled();
});
