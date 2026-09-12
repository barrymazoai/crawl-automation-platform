import { beforeEach, afterEach, expect, it, vi } from "vitest";
const env=vi.hoisted(()=>({reserve:vi.fn(),release:vi.fn(),verify:vi.fn(),sleep:vi.fn(),options:vi.fn(),patched:vi.fn((_id:string)=>true)}));
vi.mock("@temporalio/workflow",()=>({
  proxyActivities:(options:unknown)=>{env.options(options);return{reserveResources:env.reserve,releaseResources:env.release,verifyResourceReviewStopped:env.verify};},
  sleep:env.sleep,workflowInfo:()=>({workflowId:"test-product",runId:"00000000-0000-4000-8000-000000000001"}),
  patched:env.patched,
  ApplicationFailure:{nonRetryable:(_message:string,code:string)=>Error(code)},
}));
import { resourceGate } from "./resource-workflow.js";
const config={queue:"resources",activities:{ocr:[{resourceId:"ocr-cpu",units:1}]},maxWaitSeconds:10};
beforeEach(()=>{vi.clearAllMocks();env.patched.mockReturnValue(true);vi.useFakeTimers();vi.setSystemTime(100000);
  env.reserve.mockImplementation(async r=>({permitId:r.permitId,status:"granted",reason:"available"}));
  env.release.mockImplementation(async r=>({permitId:r.permitId,status:"released",reason:"released"}));
  env.sleep.mockImplementation(async()=>{vi.setSystemTime(Date.now()+10000);});});
afterEach(()=>vi.useRealTimers());
it("Review result is preserved but resource remains quarantined",async()=>{
  const result={status:"review",code:"VISION.EXECUTION_UNKNOWN"};
  expect(await resourceGate(config)("ocr",async()=>result)).toEqual(result);expect(env.release).not.toHaveBeenCalled();
});
it("opt-in verified stopped quality Review releases capacity without changing Review",async()=>{
  env.verify.mockImplementation(async({request})=>({permitId:request.permitId,status:"stopped",evidenceKey:"v3/resource-stop/test.json"}));
  const out={status:"review",reviewId:"review-1",code:"TEXT.LABEL_GROUP_EMPTY"};
  expect(await resourceGate({...config,reviewStopCheck:true})("ocr",async()=>out)).toBe(out);
  expect(env.verify).toHaveBeenCalledOnce();expect(env.release).toHaveBeenCalledOnce();
});
it.each(["unknown","foreign","missing-key","throw"])("does not release unverified stop %s",async mode=>{
  env.verify.mockImplementation(async({request})=>{if(mode==="throw")throw Error("lost");return{permitId:mode==="foreign"?"other":request.permitId,status:mode==="unknown"?"unknown":"stopped",evidenceKey:mode==="missing-key"?undefined:"v3/resource-stop/test.json"};});
  await resourceGate({...config,reviewStopCheck:true})("ocr",async()=>({status:"review"}));expect(env.release).not.toHaveBeenCalled();
});
it("old histories without patch retain their original release sequence",async()=>{
  env.patched.mockReturnValue(false);await resourceGate(config)("ocr",async()=>({status:"review"}));expect(env.release).toHaveBeenCalledOnce();
});
it("legacy and unrelated activities have no resource commands",async()=>{
  const fn=vi.fn(async()=>42);expect(await resourceGate(undefined)("ocr",fn)).toBe(42);
  expect(await resourceGate(config)("receipt",fn)).toBe(42);expect(env.reserve).not.toHaveBeenCalled();
});
it("waits in workflow before starting expensive work; all needs share one stable permit",async()=>{
  env.reserve.mockImplementationOnce(async r=>({permitId:r.permitId,status:"waiting",reason:"capacity"}));
  const fn=vi.fn(async()=>{expect(env.sleep).toHaveBeenCalledOnce();return 7;});
  expect(await resourceGate(config)("ocr",fn)).toBe(7);expect(fn).toHaveBeenCalledOnce();
  expect(env.reserve.mock.calls[0]).toEqual(env.reserve.mock.calls[1]);expect(env.release).toHaveBeenCalledOnce();
});
it("timeout or unknown effect does not release permit",async()=>{
  const fn=vi.fn(async()=>{throw Error("activity acknowledgement lost");});
  await expect(resourceGate(config)("ocr",fn)).rejects.toThrow("acknowledgement");expect(fn).toHaveBeenCalledOnce();expect(env.release).not.toHaveBeenCalled();
});
it("unhealthy wait limit starts no provider operation",async()=>{
  env.reserve.mockImplementation(async r=>({permitId:r.permitId,status:"waiting",reason:"unhealthy"}));
  const fn=vi.fn();await expect(resourceGate(config)("ocr",fn)).rejects.toThrow("RESOURCE.WAIT_LIMIT");expect(fn).not.toHaveBeenCalled();
});
it("healthy capacity can wait beyond the old deadline then execute exactly once",async()=>{
  for(let n=0;n<5;n++)env.reserve.mockImplementationOnce(async r=>({permitId:r.permitId,status:"waiting",reason:"capacity"}));
  const run=vi.fn(async()=>7);expect(await resourceGate(config)("ocr",run)).toBe(7);
  expect(run).toHaveBeenCalledOnce();expect(env.release).toHaveBeenCalledOnce();expect(env.sleep).toHaveBeenCalledTimes(5);
  expect(new Set(env.reserve.mock.calls.map(c=>JSON.stringify(c[0]))).size).toBe(1);
});
it("unhealthy budget begins after capacity waiting and resets when health returns",async()=>{
  for(const reason of ["capacity","capacity","unhealthy","capacity","unhealthy","unhealthy"])
    env.reserve.mockImplementationOnce(async r=>({permitId:r.permitId,status:"waiting",reason}));
  const run=vi.fn();await expect(resourceGate(config)("ocr",run)).rejects.toThrow("RESOURCE.WAIT_LIMIT");
  expect(env.sleep).toHaveBeenCalledTimes(5);expect(run).not.toHaveBeenCalled();expect(env.release).not.toHaveBeenCalled();
});
it("cancelling normal wait starts no business operation and releases no ungranted permit",async()=>{
  env.reserve.mockImplementation(async r=>({permitId:r.permitId,status:"waiting",reason:"capacity"}));
  env.sleep.mockRejectedValueOnce(Error("cancelled"));const run=vi.fn();
  await expect(resourceGate(config)("ocr",run)).rejects.toThrow("cancelled");expect(run).not.toHaveBeenCalled();expect(env.release).not.toHaveBeenCalled();
});
it("old capacity-wait histories preserve their original timeout",async()=>{
  env.patched.mockImplementation(id=>id!=="resource-capacity-wait-v1");
  env.reserve.mockImplementation(async r=>({permitId:r.permitId,status:"waiting",reason:"capacity"}));
  const run=vi.fn();await expect(resourceGate(config)("ocr",run)).rejects.toThrow("RESOURCE.WAIT_LIMIT");
  expect(run).not.toHaveBeenCalled();expect(env.sleep).toHaveBeenCalledOnce();
});
it("independent concurrent activities get different permits",async()=>{
  const gate=resourceGate(config);await Promise.all([gate("ocr",async()=>1),gate("ocr",async()=>2)]);
  expect(new Set(env.reserve.mock.calls.map(c=>c[0].permitId)).size).toBe(2);
});
it("retries only idempotent control operations",async()=>{
  await resourceGate(config)("ocr",async()=>0);expect(env.options).toHaveBeenCalledWith(expect.objectContaining({retry:{maximumAttempts:3}}));
});
it.each(["foreign","released"])("rejects %s admission without starting provider",async mode=>{
  env.reserve.mockImplementation(async r=>({permitId:mode==="foreign"?"other":r.permitId,status:mode==="released"?"released":"granted",reason:mode==="released"?"released":"available"}));
  const fn=vi.fn();await expect(resourceGate(config)("ocr",fn)).rejects.toThrow("RESOURCE.IDENTITY_CONFLICT");expect(fn).not.toHaveBeenCalled();
});

it("single-label fallback cannot advance while a prior Review execution stop is unverified",async()=>{
 env.verify.mockRejectedValue(Error("unknown"));
 await expect(resourceGate({...config,reviewStopCheck:true},{requireReviewStop:true})("ocr",async()=>({status:"review"}))).rejects.toThrow("RESOURCE.REVIEW_STOP_UNVERIFIED");expect(env.release).not.toHaveBeenCalled();
});
