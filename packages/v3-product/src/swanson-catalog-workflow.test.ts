import { beforeEach, expect, it, vi } from "vitest";
const env = vi.hoisted(() => ({ activities: {} as Record<string, any>, start: vi.fn(), held: false, release: vi.fn(), events: [] as string[],streaming:false,families:false }));
vi.mock("@temporalio/workflow", () => ({ proxyActivities: ({ taskQueue }: any) => env.activities[taskQueue], workflowInfo: () => ({ workflowId: "product", runId: "00000000-0000-4000-8000-000000000001", taskQueue: "input" }),
  startChild: env.start, ParentClosePolicy: { ABANDON: "ABANDON",REQUEST_CANCEL:"REQUEST_CANCEL" }, ChildWorkflowCancellationType:{ABANDON:"ABANDON"}, WorkflowIdReusePolicy: { REJECT_DUPLICATE: "REJECT_DUPLICATE" },
  patched: (id:string) => id==="swanson-file-stream-v1"?env.streaming:id==="swanson-family-variants-v1"?env.families:true, sleep: async () => {}, isCancellation: (e: any) => e?.message === "cancelled", CancellationScope: { nonCancellable: (fn: any) => fn() },
  ApplicationFailure: class extends Error { constructor(m: string, readonly type: string) { super(m); } static nonRetryable(m: string, c: string) { return new this(m, c); } } }));
import { SwansonCatalogProductWorkflow } from "./swanson-catalog-workflow.js";
import { SwansonProductJobs } from "./swanson-product-jobs.js";
import { swansonLiveFixture } from "../../v3-channels/src/swanson-live.fixture.js";
const signal = () => AbortSignal.timeout(3000);
beforeEach(() => { vi.clearAllMocks(); env.held = false; env.events = [];env.streaming=false;env.families=false; });
async function setup() {
  const f = swansonLiveFixture(), job = await f.job(), captured = await f.live.capture(job, signal());
  const names = ["plan", "page", "pageText", "imagePrepare", "ocr", "ocrReceipts", "keywords", "core", "source", "manifest", "text", "textReceipts", "vision", "assembly", "collection", "review"];
  const handoff = { job, input: { input: { operationId: "label-operation", sourcePlan: captured.sourcePlan, corePolicy: "swanson-label-core/1",
    text: { ...f.settings.text, resultSchemaVersion: 3, implementationVersion: "codex-text/3", policyVersion: "label-text/4" },
    visionConfigFingerprint: f.settings.visionConfigFingerprint, evidencePolicy: "label-image-first/3" }, queues: Object.fromEntries(names.map(n => [n, n])) } };
  const review = { status: "review", operationId: job.operationId, reviewId: "review-id", code: "SWANSON.BROWSER_PHASE_UNRESOLVED", evidenceKey: "reviews/one.json", automaticRetry: false };
  env.activities = {
    input: { prepareSwansonProduct: vi.fn(async () => job), prepareSwansonLabel: vi.fn(async () => { expect(env.held).toBe(false); return handoff; }) },
    capture: { captureSwansonProduct: vi.fn(async () => { expect(env.held).toBe(true); env.events.push("capture"); return captured; }),
      closeSwansonProductPage: vi.fn(async () => { env.events.push("close"); return { taskId: job.sessionId, status: "closed" }; }) },
    plan: { prepareChannelProduct: (p: unknown) => f.plans.run(p, signal()) },
    file: { acquireSwansonFile: vi.fn(async (raw: any) => { expect(env.held).toBe(true); env.events.push("file"); return { status: "durable", operationId: raw.input.operationId,
      evidenceKey: "files/fixture.json", file: { ...captured.sourcePlan.source, kind: "source-image", mediaType: "image/jpeg", producer: { operationId: raw.input.operationId, module: "file.acquire", implementationVersion: "1" } } }; }) },
    review: { reviewSwansonProduct: vi.fn(async () => review) },
    resource: { reserveResources: async (r: any) => { env.held = true; return { permitId: r.permitId, status: "granted", reason: "available" }; },
      releaseResources: async (r: any) => { env.held = false; env.events.push("release"); env.release(); return { permitId: r.permitId, status: "released", reason: "released" }; } },
  };
  env.start.mockImplementation(async () => { expect(env.held).toBe(false); env.events.push("label"); return { result: async () => ({ status: "review", code: "fixture-quality" }) }; });
  return { ...f, job, captured, handoff, review };
}
it("closes page and releases browser before starting independent OCR/model child", async () => {
  const f = await setup(); expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toMatchObject({ status: "review", code: "fixture-quality" });
  expect(env.events).toEqual(["capture", "file", "file", "file", "close", "release", "label"]);
  expect(env.start).toHaveBeenCalledWith("ChannelSavedLabelWorkflow", expect.objectContaining({ workflowId: "product-label", parentClosePolicy: "ABANDON" }));
});
it("capture uncertainty becomes a passive Review, keeps lease quarantined and closes exact page", async () => {
  const f = await setup(); env.activities.capture.captureSwansonProduct.mockRejectedValue(Error("lost"));
  expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toEqual(f.review);
  expect(env.release).not.toHaveBeenCalled(); expect(env.start).not.toHaveBeenCalled(); expect(env.activities.capture.closeSwansonProductPage).toHaveBeenCalledOnce();
});
it("explicit user-control Review performs no further browser actions", async () => {
  const f = await setup(); env.activities.capture.captureSwansonProduct.mockResolvedValue({ ...f.review, code: "SOURCE.BROWSER_USER_CONTROL" });
  expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toMatchObject({ code: "SOURCE.BROWSER_USER_CONTROL" });
  expect(env.activities.capture.closeSwansonProductPage).not.toHaveBeenCalled(); expect(env.start).not.toHaveBeenCalled(); expect(env.release).not.toHaveBeenCalled();
});
it("cleanup uncertainty cannot start downstream models", async () => {
  const f = await setup(); env.activities.capture.closeSwansonProductPage.mockResolvedValue({ taskId: f.job.sessionId, status: "pending" });
  expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toEqual(f.review); expect(env.start).not.toHaveBeenCalled(); expect(env.release).not.toHaveBeenCalled();
});
it("nested Temporal user-control failure is not followed by cleanup", async () => {
  const f = await setup(); env.activities.capture.captureSwansonProduct.mockRejectedValue({ type: "ActivityFailure", cause: { type: "SOURCE.BROWSER_USER_CONTROL" } });
  expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toEqual(f.review);
  expect(env.activities.capture.closeSwansonProductPage).not.toHaveBeenCalled(); expect(env.release).not.toHaveBeenCalled();
  expect(env.activities.review.reviewSwansonProduct).toHaveBeenCalledWith(expect.objectContaining({ causeCode: "SOURCE.BROWSER_USER_CONTROL" }));
});
it("file Review stops this family without hiding it as browser success", async () => {
  const f = await setup(); env.activities.file.acquireSwansonFile.mockImplementation(async ({ input }: any) => ({ ...f.review, operationId: input.operationId, code: "ACQUIRE.EXECUTION_UNKNOWN" }));
  expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toMatchObject({ code: "ACQUIRE.EXECUTION_UNKNOWN" });
  expect(env.start).not.toHaveBeenCalled(); expect(env.release).not.toHaveBeenCalled(); expect(env.activities.capture.closeSwansonProductPage).toHaveBeenCalledOnce();
});
it("cancellation is propagated and does not manufacture a business Review", async () => {
  const f = await setup(); env.activities.capture.captureSwansonProduct.mockRejectedValue(Error("cancelled"));
  await expect(SwansonCatalogProductWorkflow(f.job.discovery)).rejects.toThrow("cancelled"); expect(env.activities.review.reviewSwansonProduct).not.toHaveBeenCalled();
});
it("handoff cannot swap in another source plan", async () => {
  const f = await setup(); f.handoff.input.input.sourcePlan = { ...f.captured.sourcePlan, operationId: "foreign" };
  await expect(SwansonCatalogProductWorkflow(f.job.discovery)).rejects.toThrow(); expect(env.start).not.toHaveBeenCalled();
});
it("job factory checks durable discovery and pins unique identities before returning", async () => {
  const f = await setup(), db = { query: vi.fn(async () => ({ rows: [{ record: f.job.discovery }], rowCount: 1 })) };
  const policy = { scope: f.scope, queues: f.job.queues, resources: f.job.resources }, jobs = new SwansonProductJobs(db, f.publication, policy);
  const job = await jobs.prepare(f.job.discovery, "product", signal());
  expect(await jobs.prepare(f.job.discovery, "product", signal())).toEqual(job);
  await expect(jobs.prepare(f.job.discovery, "other", signal())).rejects.toThrow("DISCOVERY_IDENTITY");
  const changed = new SwansonProductJobs(db, f.publication, { ...policy, queues: { ...policy.queues, label: "other" } });
  await expect(changed.prepare(f.job.discovery, "product", signal())).rejects.toThrow("POLICY_CONFLICT");
  db.query.mockResolvedValue({ rows: [], rowCount: 0 }); await expect(jobs.prepare(f.job.discovery, "product", signal())).rejects.toThrow("DISCOVERY_UNVERIFIED");
});
async function streamingSetup(){
  const f=await setup();env.streaming=true;
  env.activities.input.prepareSwansonStreamingLabel=vi.fn(async()=>{expect(env.held).toBe(true);return f.handoff;});
  const plan=await f.plans.run(f.captured.sourcePlan,signal());if(plan.status!=="prepared")throw Error("plan");
  env.activities.file.acquireSwansonFile.mockImplementation(async({input}:any)=>{
    const source=plan.manifest.sources.find(s=>s.kind==="file-image"&&s.plan.acquire.operationId===input.operationId);if(!source||source.kind!=="file-image")throw Error("file");
    env.events.push("file");return{status:"durable",operationId:input.operationId,evidenceKey:"files/fixture.json",file:{...f.captured.sourcePlan.source,artifactId:source.plan.imageId,kind:"source-image",mediaType:"image/jpeg",producer:{operationId:input.operationId,module:"file.acquire",implementationVersion:input.implementationVersion}}};
  });
  const signals:any[]=[],child={signal:vi.fn(async(name:string,raw:any)=>{signals.push({name,...raw});env.events.push(name==="channelSourceReady"?"ready":raw.status);}),result:vi.fn(async()=>{expect(env.held).toBe(false);return{status:"collected"};})};
  env.start.mockImplementation(async()=>{expect(env.held).toBe(true);env.events.push("label");return child;});return{...f,child,signals};
}
it("stream browser phase publishes every file before the next; closure gates final collection",async()=>{
  const f=await streamingSetup();expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toMatchObject({status:"collected"});
  expect(env.events).toEqual(["capture","label","file","ready","file","ready","file","ready","close","release","closed"]);
  expect(env.start).toHaveBeenCalledWith("ChannelStreamingLabelWorkflow",expect.objectContaining({parentClosePolicy:"REQUEST_CANCEL"}));
  expect(f.child.result).toHaveBeenCalledOnce();
});
it("stream failure signals the child before passive Review and preserves quarantined browser capacity",async()=>{
  const f=await streamingSetup();env.activities.file.acquireSwansonFile.mockRejectedValue(Error("unknown"));f.child.result.mockImplementation(async()=>({status:"review"}));
  expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toEqual(f.review);expect(f.signals.at(-1)).toMatchObject({name:"channelStreamSealed",status:"failed"});
  expect(env.release).not.toHaveBeenCalled();expect(env.activities.capture.closeSwansonProductPage).toHaveBeenCalledOnce();
});
it("stream cancellation closes the exact page and seals downstream without creating a business Review",async()=>{
  const f=await streamingSetup();env.activities.file.acquireSwansonFile.mockRejectedValue(Error("cancelled"));
  await expect(SwansonCatalogProductWorkflow(f.job.discovery)).rejects.toThrow("cancelled");expect(f.signals.at(-1)).toMatchObject({status:"failed"});
  expect(env.activities.capture.closeSwansonProductPage).toHaveBeenCalledOnce();expect(env.activities.review.reviewSwansonProduct).not.toHaveBeenCalled();
});
async function familySetup(){
 const f=await setup();env.families=true;
 const members=["101","102"].map(id=>({owned:true,job:{...f.job,familyDiscovery:f.job.discovery,operationId:`capture-${id}`,sessionId:`page-${id}`,
  discovery:{...f.job.discovery,discoveryId:`variant-${id}`,workflowId:`variant-${id}`,entry:{...f.job.discovery.entry,kind:"product",variantId:id}}}}));
 env.activities.capture.enumerateSwansonFamily=vi.fn(async()=>{expect(env.held).toBe(true);env.events.push("enumerate-close");return{};});
 env.activities.input.prepareSwansonFamilyProducts=vi.fn(async()=>{expect(env.held).toBe(false);return members;});
 env.activities.input.inspectSwansonFamilyProducts=vi.fn(async()=>({coverage:"declared-options",states:members.map(m=>({workflowId:m.job.discovery.workflowId,status:"COMPLETED",held:false}))}));
 env.start.mockImplementation(async()=>{expect(env.held).toBe(false);env.events.push("variant");return{result:async()=>({status:"collected"})};});
 return{...f,members};
}
it("family closes its enumeration page before distinct SKU children and does not run the default SKU twice",async()=>{
 const f=await familySetup();expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toEqual({status:"completed",coverage:"declared-options",variants:2});
 expect(env.events).toEqual(["enumerate-close","release","variant","variant"]);expect(env.activities.capture.captureSwansonProduct).not.toHaveBeenCalled();
 expect(env.start.mock.calls.map(c=>c[1].workflowId)).toEqual(["variant-101","variant-102"]);
});
it("overlapping family references wait for the same SKU without starting it twice",async()=>{
 const f=await familySetup();f.members[1]!.owned=false;
 env.activities.input.inspectSwansonFamilyProducts.mockResolvedValueOnce({coverage:"declared-options",states:f.members.map(m=>({workflowId:m.job.discovery.workflowId,status:"RUNNING",held:true}))});
 expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toMatchObject({variants:2});expect(env.start).toHaveBeenCalledOnce();expect(env.activities.input.inspectSwansonFamilyProducts).toHaveBeenCalledTimes(2);
});
it("a later variant dispatch failure preserves and waits for the already started sibling",async()=>{
 const f=await familySetup(),completed=vi.fn(async()=>({status:"collected"}));env.start.mockResolvedValueOnce({result:completed}).mockRejectedValueOnce(Error("lost dispatch"));
 expect(await SwansonCatalogProductWorkflow(f.job.discovery)).toEqual(f.review);expect(completed).toHaveBeenCalledOnce();expect(env.start).toHaveBeenCalledTimes(2);
});
