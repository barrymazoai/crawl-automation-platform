import { beforeEach, afterEach, expect, it, vi } from "vitest";
const env=vi.hoisted(()=>({reserve:vi.fn(),release:vi.fn(),verify:vi.fn(),sleep:vi.fn(),options:vi.fn(),patched:vi.fn((_id:string)=>true)}));
vi.mock("@temporalio/workflow",()=>({
  proxyActivities:(options:unknown)=>{env.options(options);return{reserveResources:env.reserve,releaseResources:env.release,verifyResourceReviewStopped:env.verify};},
  sleep:env.sleep,workflowInfo:()=>({workflowId:"test-product",runId:"00000000-0000-4000-8000-000000000001"}),
  patched:env.patched, CancellationScope:{nonCancellable:(fn:()=>Promise<unknown>)=>fn()}, ActivityCancellationType:{WAIT_CANCELLATION_COMPLETED:"WAIT_CANCELLATION_COMPLETED"},
  ApplicationFailure:{nonRetryable:(_message:string,code:string)=>Error(code)},
}));
import { resourceGate } from "./resource-workflow.js";
const config={queue:"resources",activities:{ocr:[{resourceId:"ocr-cpu",units:1}]},maxWaitSeconds:10};
beforeEach(()=>{vi.clearAllMocks();env.patched.mockImplementation(id=>!['resource-recovery-bounds-v1','resource-execution-finally-v1'].includes(id));vi.useFakeTimers();vi.setSystemTime(100000);
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

it('new histories stop sibling admission when a completed Review cannot publish stop proof',async()=>{
 env.patched.mockReturnValue(true);let granted=false;
 env.reserve.mockImplementation(async r=>{if(!granted){granted=true;return{permitId:r.permitId,status:'granted',reason:'available'};}return{permitId:r.permitId,status:'waiting',reason:'capacity'};});
 env.verify.mockRejectedValue(Error('proof unavailable'));
 const gate=resourceGate({...config,maxWaitSeconds:900,reviewStopCheck:true}),first=vi.fn(async()=>({status:'review'})),second=vi.fn(async()=>1);
 const results=await Promise.allSettled([gate('ocr',first),gate('ocr',second)]);
 expect(results.every(r=>r.status==='rejected')).toBe(true);expect(first).toHaveBeenCalledOnce();expect(second).not.toHaveBeenCalled();expect(env.release).not.toHaveBeenCalled();
 expect(env.reserve.mock.calls.length).toBeLessThan(5);
});
it('new histories bound healthy capacity waits without starting a provider or releasing another owner',async()=>{
 env.patched.mockReturnValue(true);env.reserve.mockImplementation(async r=>({permitId:r.permitId,status:'waiting',reason:'capacity'}));
 const fn=vi.fn();await expect(resourceGate(config)('ocr',fn)).rejects.toThrow('RESOURCE.WAIT_LIMIT');expect(fn).not.toHaveBeenCalled();expect(env.release).not.toHaveBeenCalled();
});
it('returns a newly granted but unused sibling permit after quarantine wins the race',async()=>{
 env.patched.mockReturnValue(true);let pending!:(v:any)=>void,calls=0;
 env.reserve.mockImplementation(async r=>++calls===1?{permitId:r.permitId,status:'granted',reason:'available'}:new Promise(resolve=>{pending=()=>resolve({permitId:r.permitId,status:'granted',reason:'available'});}));
 env.verify.mockRejectedValue(Error('unknown'));const gate=resourceGate({...config,reviewStopCheck:true}),fn=vi.fn();
 const first=gate('ocr',async()=>({status:'review'})),checked=expect(first).rejects.toThrow('RESOURCE.REVIEW_STOP_UNVERIFIED'),second=gate('ocr',fn),secondChecked=expect(second).rejects.toThrow('RESOURCE.OWNER_QUARANTINED');
 await checked;pending(undefined);await secondChecked;expect(fn).not.toHaveBeenCalled();expect(env.release).toHaveBeenCalledOnce();
 expect(env.release.mock.calls[0]![0].permitId).toMatch(/-1$/);
});

function finalizer(){
 env.patched.mockReturnValue(true);
 env.verify.mockImplementation(async({request})=>({permitId:request.permitId,status:'stopped',evidenceKey:`v3/resource-stop/${request.permitId}.json`}));
 return resourceGate({...config,reviewStopCheck:true});
}
it.each(['OCR.EMPTY','ARTIFACT.UPLOAD_UNKNOWN','FUTURE.NEW_ERROR'])('finalizer preserves arbitrary Review %s and releases exactly once',async code=>{
 const gate=finalizer(),out={status:'review',reviewId:'preserved',code};
 expect(await gate('ocr',async binding=>{expect(binding?.activityId).toMatch(/^permit-/);return out;})).toBe(out);
 expect(env.verify).toHaveBeenCalledOnce();expect(env.release).toHaveBeenCalledOnce();
});
it.each(['failed','cancelled'])('finalizer releases a confirmed stopped %s call and rethrows its original error',async kind=>{
 const gate=finalizer(),error=Error(kind);
 await expect(gate('ocr',async()=>{throw error;})).rejects.toBe(error);
 expect(env.verify).toHaveBeenCalledWith(expect.objectContaining({activityId:expect.stringMatching(/^permit-/),outcome:{status:'failed'}}));
 expect(env.release).toHaveBeenCalledOnce();
});
it.each(['unknown','wrong-key','unavailable'])('finalizer retains an uncertain permit (%s) and blocks further admission',async mode=>{
 const gate=finalizer(),error=Error('original'),next=vi.fn();
 env.verify.mockImplementation(async({request})=>{if(mode==='unavailable')throw Error();return{permitId:request.permitId,status:mode==='unknown'?'unknown':'stopped',evidenceKey:'v3/resource-stop/another-permit.json'};});
 await expect(gate('ocr',async()=>{throw error;})).rejects.toBe(error);
 await expect(gate('ocr',next)).rejects.toThrow('RESOURCE.OWNER_QUARANTINED');
 expect(env.release).not.toHaveBeenCalled();expect(next).not.toHaveBeenCalled();
});
it('release outage preserves the original exception and quarantines siblings',async()=>{
 const gate=finalizer(),error=Error('original');env.release.mockRejectedValue(Error('ledger offline'));
 await expect(gate('ocr',async()=>{throw error;})).rejects.toBe(error);
 await expect(gate('ocr',async()=>1)).rejects.toThrow('RESOURCE.OWNER_QUARANTINED');
});
it('successful calls release without a stop-proof round trip',async()=>{
 const gate=finalizer();expect(await gate('ocr',async()=>42)).toBe(42);
 expect(env.release).toHaveBeenCalledOnce();expect(env.verify).not.toHaveBeenCalled();
});

it('backoff patch: healthy capacity waits are not cut by the time budget, poll less often, and still end at the iteration cap',async()=>{
 env.patched.mockReturnValue(true);env.reserve.mockImplementation(async r=>({permitId:r.permitId,status:'waiting',reason:'capacity'}));
 env.sleep.mockImplementation(async(d:string)=>{vi.setSystemTime(Date.now()+Number(d.split(' ')[0])*1000);});
 const fn=vi.fn();await expect(resourceGate(config)('ocr',fn)).rejects.toThrow('RESOURCE.WAIT_LIMIT');
 expect(fn).not.toHaveBeenCalled();expect(env.release).not.toHaveBeenCalled();
 expect(env.sleep).toHaveBeenCalledTimes(399);
 // sleep k happens after wait k+1 was counted: waits 1..29 -> 10s, 30..119 -> 30s, 120.. -> 60s
 expect(env.sleep.mock.calls[0]![0]).toBe('10 seconds');expect(env.sleep.mock.calls[28]![0]).toBe('10 seconds');
 expect(env.sleep.mock.calls[29]![0]).toBe('30 seconds');expect(env.sleep.mock.calls[118]![0]).toBe('30 seconds');expect(env.sleep.mock.calls[119]![0]).toBe('60 seconds');
});
it('backoff patch: consecutive unhealthy time still exhausts the dependency budget quickly',async()=>{
 env.patched.mockReturnValue(true);env.reserve.mockImplementation(async r=>({permitId:r.permitId,status:'waiting',reason:'unhealthy'}));
 const fn=vi.fn();await expect(resourceGate(config)('ocr',fn)).rejects.toThrow('RESOURCE.WAIT_LIMIT');
 expect(env.sleep.mock.calls.length).toBeLessThanOrEqual(2);expect(fn).not.toHaveBeenCalled();
});
it('without the backoff patch the old bounded deadline behaviour is replayed unchanged',async()=>{
 env.patched.mockImplementation(id=>id!=='resource-wait-backoff-v1');env.reserve.mockImplementation(async r=>({permitId:r.permitId,status:'waiting',reason:'capacity'}));
 const fn=vi.fn();await expect(resourceGate(config)('ocr',fn)).rejects.toThrow('RESOURCE.WAIT_LIMIT');
 expect(env.sleep.mock.calls.length).toBeLessThan(5);expect(env.sleep.mock.calls.every(c=>c[0]==='10 seconds')).toBe(true);
});
