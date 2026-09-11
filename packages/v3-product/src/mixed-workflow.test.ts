import { beforeEach, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ activities: {} as Record<string, Record<string, (...args: any[]) => Promise<unknown>>>, query: null as null | (() => unknown) }));
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: ({ taskQueue }: { taskQueue: string }) => runtime.activities[taskQueue],
  isCancellation: (error: unknown) => error instanceof Error && error.message === "cancelled",
  defineQuery: (name: string) => name, setHandler: (_name: unknown, handler: () => unknown) => { runtime.query = handler; },
  ApplicationFailure: class extends Error { constructor(message: string, readonly type: string) { super(message); }
    static nonRetryable(message: string, type: string) { return new this(message, type); } },
}));
import { MixedProductWorkflow } from "./mixed-workflow.js";
import { mixedFixture } from "./mixed.fixture.js";
beforeEach(() => { runtime.activities = {}; runtime.query = null; });
async function setup() {
  const f = await mixedFixture(), textEntry = f.entries.find(e => e.kind === "text")!;
  const key = `v3/product-evidence/${f.join.manifest.operationId}/assembly.json`;
  const saved = { status: "collected", operationId: f.join.manifest.operationId, observationId: f.owner.observationId, evidenceKey: key, recordHash: "a".repeat(64) };
  const text = vi.fn(async () => ({ status: "registered", operationId: f.task.operationId }));
  const receipts = vi.fn(async () => ({ status: "registered", registration: textEntry.record }));
  const vision = vi.fn(async (): Promise<unknown> => ({ status: "registered", operationId: f.visionTask.input.operationId }));
  const assembly = vi.fn(async (_join: unknown): Promise<unknown> => ({ status: "ready", evidenceKey: key }));
  const collection = vi.fn(async (): Promise<unknown> => saved);
  runtime.activities = { text: { interpretText: text }, receipts: { resolveTextReceipt: receipts }, vision: { interpretImage: vision },
    assembly: { assembleProductEvidence: assembly }, collection: { collectMixedProduct: collection } };
  const plan = { manifest: f.join.manifest, queues: { text: "text", textReceipts: "receipts", vision: "vision", assembly: "assembly", collection: "collection" } };
  return { ...f, plan, text, receipts, vision, assembly, collection, saved, key };
}
it("parallel branches finish before join; slow receipt does not stop vision", async () => {
  const f = await setup(); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; }), original = f.receipts.getMockImplementation()!;
  f.receipts.mockImplementation(async () => { await gate; return original(); });
  const result = MixedProductWorkflow(f.plan);
  await vi.waitFor(() => expect(f.vision).toHaveBeenCalledOnce()); expect(f.assembly).not.toHaveBeenCalled();
  expect(runtime.query!()).toEqual({ expected: 2, finished: 1 }); release();
  expect(await result).toEqual(f.saved); expect(f.assembly).toHaveBeenCalledOnce(); expect(f.collection).toHaveBeenCalledOnce();
});
it("uncertain vision execution is sent for read-only verification, never executed again", async () => {
  const f = await setup(); f.vision.mockRejectedValue(Error("lost response"));
  await MixedProductWorkflow(f.plan);
  expect(f.assembly.mock.calls[0]![0]).toMatchObject({ states: [{ id: "text", status: "registered" }, { id: "image", status: "unresolved" }] });
  expect(f.vision).toHaveBeenCalledOnce(); expect(f.text).toHaveBeenCalledOnce();
});
it("explicit Review preserves its id, lets sibling finish, and skips collection when assembly rejects", async () => {
  const f = await setup(); f.vision.mockResolvedValue({ status: "review", reviewId: "upstream" });
  const review = { status: "review", reviewId: "assembled-review", evidenceKey: f.key, codes: ["MIXED.EVIDENCE_UNVERIFIED"], automaticRetry: false };
  f.assembly.mockResolvedValue(review);
  expect(await MixedProductWorkflow(f.plan)).toEqual(review); expect(f.receipts).toHaveBeenCalledOnce();
  expect(f.assembly.mock.calls[0]![0]).toMatchObject({ states: [{ id: "text", status: "registered" }, { id: "image", status: "review", reviewId: "upstream" }] });
  expect(f.collection).not.toHaveBeenCalled();
});
it("foreign vision receipt is rejected even if source is optional", async () => {
  const f = await setup(); f.plan.manifest.sources[1]!.required = false;
  f.vision.mockResolvedValue({ status: "registered", operationId: "foreign" });
  await MixedProductWorkflow(f.plan);
  expect(f.assembly.mock.calls[0]![0]).toMatchObject({ states: [{ id: "text", status: "registered" }, { id: "image", status: "rejected" }] });
});
it("foreign text receipt cannot recover through a success claim", async () => {
  const f = await setup(); f.receipts.mockResolvedValue({ status: "registered", registration: { ...f.entries[0]!.record, input: { ...f.task, operationId: "foreign" } } } as never);
  await MixedProductWorkflow(f.plan);
  expect(f.assembly.mock.calls[0]![0]).toMatchObject({ states: [{ id: "text", status: "rejected" }, { id: "image", status: "registered" }] });
});
it("cancellation never schedules reconciliation, join or collection", async () => {
  const f = await setup(); f.vision.mockRejectedValue(Error("cancelled"));
  await expect(MixedProductWorkflow(f.plan)).rejects.toThrow("cancelled"); expect(f.assembly).not.toHaveBeenCalled(); expect(f.collection).not.toHaveBeenCalled();
});
it("malformed input and forged downstream receipts fail clearly, not workflow-task retry loops", async () => {
  const f = await setup(); await expect(MixedProductWorkflow({})).rejects.toThrow("Invalid mixed product plan");
  f.assembly.mockResolvedValue({ status: "ready", evidenceKey: "foreign/assembly.json" });
  await expect(MixedProductWorkflow(f.plan)).rejects.toThrow("identity mismatch"); expect(f.collection).not.toHaveBeenCalled();
  f.assembly.mockResolvedValue({ status: "ready", evidenceKey: f.key }); f.collection.mockResolvedValue({ ...f.saved, operationId: "foreign" });
  await expect(MixedProductWorkflow(f.plan)).rejects.toThrow("identity mismatch");
});
