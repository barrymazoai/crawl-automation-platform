import { beforeEach, expect, it, vi } from "vitest";
const env = vi.hoisted(() => ({ activities: {} as Record<string, any>, start: vi.fn(), held: false, permits:new Set<string>(), release: vi.fn(), events: [] as string[],streaming:false,families:false }));
vi.mock("@temporalio/workflow", () => ({ proxyActivities: ({ taskQueue }: any) => env.activities[taskQueue], workflowInfo: () => ({ workflowId: "product", runId: "00000000-0000-4000-8000-000000000001", taskQueue: "input" }),
  startChild: env.start, ParentClosePolicy: { ABANDON: "ABANDON",REQUEST_CANCEL:"REQUEST_CANCEL" }, ChildWorkflowCancellationType:{ABANDON:"ABANDON"}, WorkflowIdReusePolicy: { REJECT_DUPLICATE: "REJECT_DUPLICATE" },
  patched: (id:string) => id==="dtc-file-stream-v1"?env.streaming:id==="dtc-family-variants-v1"?env.families:true, sleep: async () => {}, isCancellation: (e: any) => e?.message === "cancelled", CancellationScope: { nonCancellable: (fn: any) => fn() },
  ApplicationFailure: class extends Error { constructor(m: string, readonly type: string) { super(m); } static nonRetryable(m: string, c: string) { return new this(m, c); } } }));
import { DtcCatalogProductWorkflow } from "./dtc-catalog-workflow.js";
import { DtcProductJobs } from "./dtc-product-jobs.js";
import { dtcFixture } from "../../v3-channels/src/dtc-live.fixture.js";
const signal = () => AbortSignal.timeout(3000);
beforeEach(() => { vi.clearAllMocks(); env.held = false;env.permits.clear(); env.events = [];env.streaming=false;env.families=false; });
async function setup() {
  const f = dtcFixture(), job = await f.job(), captured = await f.live.capture(job, signal());
  const names = ["plan", "page", "pageText", "imagePrepare", "ocr", "ocrReceipts", "keywords", "core", "source", "manifest", "text", "textReceipts", "vision", "assembly", "collection", "review"];
  const handoff = { job, input: { input: { operationId: "label-operation", sourcePlan: captured.sourcePlan,
    text: { ...f.settings.text, resultSchemaVersion: 3, implementationVersion: "codex-text/3", policyVersion: "label-text/4" },
    visionConfigFingerprint: f.settings.visionConfigFingerprint, evidencePolicy: "label-image-first/3" }, queues: Object.fromEntries(names.map(n => [n, n])) } };
  const review = { status: "review", operationId: job.operationId, reviewId: "review-id", code: "DTC.BROWSER_PHASE_UNRESOLVED", evidenceKey: "reviews/one.json", automaticRetry: false };
  env.activities = {
    input: { prepareDtcProduct: vi.fn(async () => job), prepareDtcLabel: vi.fn(async () => { expect(env.held).toBe(false); return handoff; }) },
    capture: { captureDtcProduct: vi.fn(async () => { expect(env.held).toBe(true); env.events.push("capture"); return captured; }),
      closeDtcProductPage: vi.fn(async () => { env.events.push("close"); return { taskId: job.sessionId, status: "closed" }; }) },
    plan: { prepareChannelProduct: (p: unknown) => f.plans.run(p, signal()) },
    file: { acquireDtcFile: vi.fn(async (raw: any) => { expect(env.held).toBe(true); env.events.push("file"); return { status: "durable", operationId: raw.input.operationId,
      evidenceKey: "files/fixture.json", file: { ...captured.sourcePlan.source, kind: "source-image", mediaType: "image/jpeg", producer: { operationId: raw.input.operationId, module: "file.acquire", implementationVersion: "1" } } }; }) },
    review: { reviewDtcProduct: vi.fn(async () => review) },
    resource: { reserveResources: async (r: any) => { if(r.needs.some((n:any)=>n.resourceId==="model"))env.permits.add(r.permitId);else env.held = true; return { permitId: r.permitId, status: "granted", reason: "available" }; },
      releaseResources: async (r: any) => { if(env.permits.delete(r.permitId))env.events.push("model-release");else{env.held = false; env.events.push("release"); env.release();} return { permitId: r.permitId, status: "released", reason: "released" }; } },
  };
  env.start.mockImplementation(async () => { expect(env.held).toBe(false); env.events.push("label"); return { result: async () => ({ status: "review", code: "fixture-quality" }) }; });
  return { ...f, job, captured, handoff, review };
}
it("capture uncertainty becomes a passive Review, keeps lease quarantined and closes exact page", async () => {
  const f = await setup(); env.activities.capture.captureDtcProduct.mockRejectedValue(Error("lost"));
  expect(await DtcCatalogProductWorkflow(f.job.discovery)).toEqual(f.review);
  expect(env.release).not.toHaveBeenCalled(); expect(env.start).not.toHaveBeenCalled(); expect(env.activities.capture.closeDtcProductPage).toHaveBeenCalledOnce();
});
it("explicit user-control Review performs no further browser actions", async () => {
  const f = await setup(); env.activities.capture.captureDtcProduct.mockResolvedValue({ ...f.review, code: "SOURCE.BROWSER_USER_CONTROL" });
  expect(await DtcCatalogProductWorkflow(f.job.discovery)).toMatchObject({ code: "SOURCE.BROWSER_USER_CONTROL" });
  expect(env.activities.capture.closeDtcProductPage).not.toHaveBeenCalled(); expect(env.start).not.toHaveBeenCalled(); expect(env.release).not.toHaveBeenCalled();
});
async function streamingSetup(){
  const f=await setup();env.streaming=true;
  env.activities.input.prepareDtcStreamingLabel=vi.fn(async()=>{expect(env.held).toBe(true);return f.handoff;});
  const plan=await f.plans.run(f.captured.sourcePlan,signal());if(plan.status!=="prepared")throw Error("plan");
  env.activities.file.acquireDtcFile.mockImplementation(async({input}:any)=>{
    const source=plan.manifest.sources.find(s=>s.kind==="file-image"&&s.plan.acquire.operationId===input.operationId);if(!source||source.kind!=="file-image")throw Error("file");
    env.events.push("file");return{status:"durable",operationId:input.operationId,evidenceKey:"files/fixture.json",file:{...f.captured.sourcePlan.source,artifactId:source.plan.imageId,kind:"source-image",mediaType:"image/jpeg",producer:{operationId:input.operationId,module:"file.acquire",implementationVersion:input.implementationVersion}}};
  });
  const signals:any[]=[],child={signal:vi.fn(async(name:string,raw:any)=>{signals.push({name,...raw});env.events.push(name==="channelSourceReady"?"ready":raw.status);}),result:vi.fn(async()=>{expect(env.held).toBe(false);return{status:"collected"};})};
  env.start.mockImplementation(async()=>{expect(env.held).toBe(true);env.events.push("label");return child;});return{...f,child,signals};
}
it("stream browser phase publishes every file before the next; closure gates final collection",async()=>{
  const f=await streamingSetup();expect(await DtcCatalogProductWorkflow(f.job.discovery)).toMatchObject({status:"collected"});
  expect(env.events).toEqual(["capture","model-release","label","file","ready","file","ready","close","release","closed"]);
  expect(env.start).toHaveBeenCalledWith("ChannelStreamingLabelWorkflow",expect.objectContaining({parentClosePolicy:"REQUEST_CANCEL"}));
  expect(f.child.result).toHaveBeenCalledOnce();
});
it("stream failure signals the child before passive Review and preserves quarantined browser capacity",async()=>{
  const f=await streamingSetup();env.activities.file.acquireDtcFile.mockRejectedValue(Error("unknown"));f.child.result.mockImplementation(async()=>({status:"review"}));
  expect(await DtcCatalogProductWorkflow(f.job.discovery)).toEqual(f.review);expect(f.signals.at(-1)).toMatchObject({name:"channelStreamSealed",status:"failed"});
  expect(env.release).not.toHaveBeenCalled();expect(env.activities.capture.closeDtcProductPage).toHaveBeenCalledOnce();
});
it("stream cancellation closes the exact page and seals downstream without creating a business Review",async()=>{
  const f=await streamingSetup();env.activities.file.acquireDtcFile.mockRejectedValue(Error("cancelled"));
  await expect(DtcCatalogProductWorkflow(f.job.discovery)).rejects.toThrow("cancelled");expect(f.signals.at(-1)).toMatchObject({status:"failed"});
  expect(env.activities.capture.closeDtcProductPage).toHaveBeenCalledOnce();expect(env.activities.review.reviewDtcProduct).not.toHaveBeenCalled();
});
