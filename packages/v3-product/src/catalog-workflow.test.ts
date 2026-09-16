import { beforeEach, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ activities: {} as Record<string, any>, starts: vi.fn(), continued: vi.fn() }));
vi.mock("@temporalio/workflow", () => ({ proxyActivities: ({ taskQueue }: any) => runtime.activities[taskQueue], startChild: runtime.starts,
  patched: () => true,
  continueAsNew: runtime.continued, ParentClosePolicy: { ABANDON: "ABANDON" }, WorkflowIdReusePolicy: { REJECT_DUPLICATE: "REJECT_DUPLICATE" },
  workflowInfo: () => ({ taskQueue: "product" }), isCancellation: (e: any) => e?.message === "cancelled",
  ApplicationFailure: { nonRetryable: (message: string) => Error(message) } }));
import { CatalogWorkflow, PresenceWorkflow } from "./catalog-workflow.js";
import { catalogPage, catalogScope } from "../../v3-contracts/src/catalog.fixture.js";
import { CatalogPageSchema } from "@crawl-automation/v3-contracts";
beforeEach(() => { vi.clearAllMocks(); runtime.activities = {}; });
function setup(completion: "complete" | "more" | "unknown" = "complete") {
  const page = catalogPage("catalog", 0, completion), discovery = { discoveryId: "discovery", catalogId: "catalog", scope: catalogScope, entry: page.entries[0], source: page.source, workflowId: "catalog-product-stable" };
  const source = { readCatalogPage: vi.fn(async () => page) }, ledger = { commitCatalogPage: vi.fn(async () => ({ input: page.input, pageHash: "a".repeat(64), discoveries: [discovery], completion: page.completion, nextCursor: page.nextCursor })),
    recordCatalogDispatch: vi.fn(async () => {}), closeCatalog: vi.fn(async ({ failure }: any) => ({ status: failure || completion !== "complete" ? "incomplete" : "complete" })) };
  runtime.activities = { source, ledger };
  runtime.starts.mockResolvedValue({ workflowId: discovery.workflowId, firstExecutionRunId: "00000000-0000-4000-8000-000000000001", result: () => { throw Error("Must not wait for child"); } });
  return { page, source, ledger, input: { catalogId: "catalog", scope: catalogScope, queues: { source: "source", ledger: "ledger", product: "product" }, pagesPerRun: 1 } };
}
it("closes directory without waiting for product, ABANDON survives closure", async () => {
  const f = setup(); expect(await CatalogWorkflow(f.input)).toEqual({ status: "complete" });
  expect(runtime.starts).toHaveBeenCalledWith("CatalogProductWorkflow", expect.objectContaining({ parentClosePolicy: "ABANDON", workflowIdReusePolicy: "REJECT_DUPLICATE" }));
  expect(f.ledger.recordCatalogDispatch).toHaveBeenCalledTimes(1);
});
it("Swanson route dispatches its independent product workflow before directory closure", async () => {
  const f = setup("unknown"); f.page.input.scope.channel = "swanson";
  f.input.scope = f.page.input.scope;
  const committed = await f.ledger.commitCatalogPage(); committed.discoveries[0]!.scope = f.page.input.scope;
  f.ledger.commitCatalogPage.mockResolvedValue(committed);
  expect(await CatalogWorkflow({ ...f.input, productWorkflow: "SwansonCatalogProductWorkflow" })).toEqual({ status: "incomplete" });
  expect(runtime.starts).toHaveBeenCalledWith("SwansonCatalogProductWorkflow", expect.objectContaining({ parentClosePolicy: "ABANDON" }));
});
it("Swanson route cannot run against a different channel", async () => {
  const f = setup(); f.page.input.scope.channel = "gnc";
  await expect(CatalogWorkflow({ ...f.input, productWorkflow: "SwansonCatalogProductWorkflow" })).rejects.toThrow("Foreign channel route");
  expect(runtime.starts).not.toHaveBeenCalled();
});
it("bounded page history continues with cursor and index, without closing children", async () => {
  const f = setup("more"); await CatalogWorkflow(f.input);
  expect(runtime.continued).toHaveBeenCalledWith(expect.objectContaining({ page: 1, cursor: f.page.nextCursor })); expect(f.ledger.closeCatalog).not.toHaveBeenCalled();
});
it.each(["source", "commit", "dispatch", "start"])("%s failure closes incomplete once without retrying", async mode => {
  const f = setup(); const fn = mode === "source" ? f.source.readCatalogPage : mode === "commit" ? f.ledger.commitCatalogPage : mode === "dispatch" ? f.ledger.recordCatalogDispatch : runtime.starts;
  fn.mockRejectedValue(Error("lost acknowledgement")); expect(await CatalogWorkflow(f.input)).toEqual({ status: "incomplete" }); expect(fn).toHaveBeenCalledTimes(1);
});
it("cancellation propagates without manufacturing catalog completion", async () => {
  const f = setup(); f.source.readCatalogPage.mockRejectedValue(Error("cancelled")); await expect(CatalogWorkflow(f.input)).rejects.toThrow("cancelled"); expect(f.ledger.closeCatalog).not.toHaveBeenCalled();
});
it("foreign page rejected before ledger/children", async () => {
  const f = setup(); f.page.input.scope.region = "CA"; expect(await CatalogWorkflow(f.input)).toEqual({ status: "incomplete" }); expect(f.ledger.commitCatalogPage).not.toHaveBeenCalled();
});
it("unknown catalog end never gets promoted to complete", async () => { const f = setup("unknown"); expect(await CatalogWorkflow(f.input)).toEqual({ status: "incomplete" }); });
it.each(["missing-proof", "foreign-source", "loop", "oversized"])("contract rejects %s", mode => {
  const p = catalogPage("bad");
  if (mode === "missing-proof") p.endEvidence = null;
  if (mode === "foreign-source") p.source.sourceId = "other";
  if (mode === "loop") { p.input.cursor = "same"; p.nextCursor = "same"; p.completion = "more"; p.endEvidence = null; }
  if (mode === "oversized") p.entries = Array(101).fill(p.entries[0]);
  expect(CatalogPageSchema.safeParse(p).success).toBe(false);
});
it("presence delegates independently and does not launch product work", async () => {
  setup(); runtime.activities.presence = { checkPresence: vi.fn(async () => ({ status: "unknown" })) };
  expect(await PresenceWorkflow({ input: { operationId: "check", catalogId: "catalog", scope: catalogScope, listingId: "missing", variantId: null }, queue: "presence" })).toEqual({ status: "unknown" }); expect(runtime.starts).not.toHaveBeenCalled();
});
