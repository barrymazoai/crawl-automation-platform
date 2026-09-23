import { proxyActivities, sleep, workflowInfo, ApplicationFailure, ActivityFailure, patched, CancellationScope, ActivityCancellationType } from "@temporalio/workflow";
import { ResourceGateSchema, ResourceDecisionSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";

export type ResourceActivityBinding={activityId:string;cancellationType:typeof ActivityCancellationType.WAIT_CANCELLATION_COMPLETED};
export function resourceGate(raw: unknown, options:{requireReviewStop?:boolean}={}) {
  const config = raw === undefined ? undefined : ResourceGateSchema.parse(raw);
  let sequence = 0;
  // Keep historical command sequences unchanged. A new gate shares its quarantine
  // state across sibling sources, but never cancels external work already running.
  const bounded=config?patched('resource-recovery-bounds-v1'):false;
  // Healthy-but-occupied capacity is normal queueing: with this patch the time budget no longer cuts it off,
  // only the iteration cap does, and polling backs off so the cap spans hours instead of ~67 minutes.
  const backoff=config?patched('resource-wait-backoff-v1'):false;
  // Request lanes: a Review outcome releases immediately (exceptions/timeouts still quarantine, the request may be alive).
  const releaseOnReview=config?.releaseOnReview===true&&patched('resource-review-release-v1');
  // A typed business failure reported by the Activity means the request ended; a timeout/cancellation does not.
  const businessFailure=(e:unknown)=>e instanceof ActivityFailure&&e.cause instanceof ApplicationFailure;
  let quarantined=false,waits=0;
  return async <T>(name: string, run: (binding?:ResourceActivityBinding) => Promise<T>): Promise<T> => {
    const needs = config?.activities[name]; if (!config || !needs) return run();
    const checkOwner=()=>{if(bounded&&quarantined)throw ApplicationFailure.nonRetryable('Sibling execution requires recovery','RESOURCE.OWNER_QUARANTINED');};
    checkOwner();
    const info = workflowInfo();
    const request: ResourceRequest = { permitId: `permit-${info.runId}-${sequence++}`, workflowId: info.workflowId, runId: info.runId, needs };
    const ports = proxyActivities<{ reserveResources(r: ResourceRequest): Promise<unknown>; releaseResources(r: ResourceRequest): Promise<unknown> }>({
      // No automatic retry, including ledger writes; an unknown reply needs read-only reconciliation.
      taskQueue: config.queue, startToCloseTimeout: "10 seconds", scheduleToCloseTimeout: "45 seconds", retry: { maximumAttempts: patched("no-automatic-retries-v1")?1:3 } });
    const until = Date.now() + config.maxWaitSeconds * 1000;
    const waitForCapacity = patched("resource-capacity-wait-v1");
    let unhealthySince: number | undefined;
    for (;;) {
      checkOwner();
      let result;
      try{result=ResourceDecisionSchema.parse(await ports.reserveResources(request));}catch(error){quarantined=true;throw error;}
      if (result.permitId !== request.permitId || result.status === "released") throw ApplicationFailure.nonRetryable("Resource identity conflict", "RESOURCE.IDENTITY_CONFLICT");
      if (result.status === "granted") {
        if(bounded&&quarantined){
          // This sibling acquired capacity while another sibling became quarantined.
          // No external work has started under this new permit, so return it exactly.
          const returned=ResourceDecisionSchema.parse(await ports.releaseResources(request));
          if(returned.permitId!==request.permitId||returned.status!=='released')throw ApplicationFailure.nonRetryable('Unused permit release unverified','RESOURCE.RELEASE_UNKNOWN');
          checkOwner();
        }
        break;
      }
      const capacityWait=waitForCapacity&&result.reason==="capacity";
      if(bounded&&(++waits>=400||(!(backoff&&capacityWait)&&Date.now()>=until)))throw ApplicationFailure.nonRetryable('Resource wait budget exhausted; no business execution started','RESOURCE.WAIT_LIMIT');
      // Occupied but healthy capacity is normal scheduling, not a product failure.
      // Preserve the old deadline on replay; only consecutive unhealthy time counts
      // against the new dependency budget. No business Activity has started yet.
      if (waitForCapacity) {
        if (result.reason === "capacity") unhealthySince = undefined;
        else unhealthySince ??= Date.now();
      }
      if (waitForCapacity ? unhealthySince !== undefined && Date.now() - unhealthySince >= config.maxWaitSeconds * 1000 : Date.now() >= until)
        throw ApplicationFailure.nonRetryable("Resource unavailable; no business execution started", "RESOURCE.WAIT_LIMIT");
      await sleep(backoff?(waits<30?"10 seconds":waits<120?"30 seconds":"60 seconds"):"10 seconds");
    }
    if(config.reviewStopCheck&&patched("resource-execution-finally-v1")){
      // The permit is also the Activity id: exceptions/cancellation do not have a
      // business receipt, so the verifier needs an independent exact identity.
      const binding={activityId:request.permitId,cancellationType:ActivityCancellationType.WAIT_CANCELLATION_COMPLETED};
      let value:T|undefined,failed=false,caught:unknown;
      try{value=await run(binding);return value;}
      catch(error){failed=true;caught=error;throw error;}
      finally{
        await CancellationScope.nonCancellable(async()=>{
          const review=!!value&&typeof value==='object'&&'status' in value&&value.status==='review';
          if((failed&&!(releaseOnReview&&businessFailure(caught)))||(review&&!releaseOnReview)){
            const verifier=proxyActivities<{verifyResourceReviewStopped(raw:unknown):Promise<unknown>}>({
              taskQueue:config.queue,startToCloseTimeout:'90 seconds',scheduleToCloseTimeout:'2 minutes',retry:{maximumAttempts:1}});
            let stopped=false;
            try{
              const proof=await verifier.verifyResourceReviewStopped({request,activityName:name,activityId:binding.activityId,outcome:failed?{status:'failed'}:value}) as {permitId?:string;status?:string;evidenceKey?:string};
              stopped=proof?.permitId===request.permitId&&proof.status==='stopped'&&proof.evidenceKey===`v3/resource-stop/${request.permitId}.json`;
            }catch{/* No stop proof means no release, independent of the business error code. */}
            if(!stopped){
              quarantined=true;
              if(!failed)throw ApplicationFailure.nonRetryable('Execution stop unverified','RESOURCE.REVIEW_STOP_UNVERIFIED');
              return; // Preserve the original exception/cancellation.
            }
          }
          try{
            const released=ResourceDecisionSchema.parse(await ports.releaseResources(request));
            if(released.permitId!==request.permitId||released.status!=='released')throw ApplicationFailure.nonRetryable('Resource release unverified','RESOURCE.RELEASE_UNKNOWN');
          }catch(error){quarantined=true;if(!failed)throw error;}
        });
      }
    }
    // An Activity timeout/cancel may leave external work alive. Do NOT release in finally.
    // Such permits remain quarantined until a separate evidence-based recovery proves the owner stopped.
    let value:T;
    try{value=await run();}
    catch(error){
      if(releaseOnReview&&businessFailure(error)){
        try{const r=ResourceDecisionSchema.parse(await ports.releaseResources(request));if(r.permitId!==request.permitId||r.status!=='released')quarantined=true;}catch{quarantined=true;}
      }else quarantined=true;
      throw error;
    }
    // A Review receipt proves classification, not that external execution has stopped.
    // Preserve the result for downstream Review handling, but quarantine its permit.
    // Old histories retain their original command sequence during replay.
    if (patched("resource-review-quarantine-v1") && value && typeof value === "object" && "status" in value && value.status === "review" && !releaseOnReview) {
      const unverified=()=>{quarantined=true;if(bounded||options.requireReviewStop)throw ApplicationFailure.nonRetryable("Review execution stop unverified","RESOURCE.REVIEW_STOP_UNVERIFIED");return value;};
      if (!config.reviewStopCheck || !patched("resource-review-stop-proof-v1")) return unverified();
      // Only an explicit verifier may attest to a stopped execution. A Review
      // boolean, error code, timeout or missing receipt alone is never sufficient.
      const verifier = proxyActivities<{ verifyResourceReviewStopped(raw: unknown): Promise<unknown> }>({
        taskQueue: config.queue, startToCloseTimeout: bounded?"90 seconds":"30 seconds", scheduleToCloseTimeout: bounded?"2 minutes":"45 seconds", retry: { maximumAttempts: 1 } });
      try {
        const proof = await verifier.verifyResourceReviewStopped({request,activityName:name,outcome:value}) as {permitId?:string;status?:string;evidenceKey?:string};
        if (proof?.permitId!==request.permitId || proof.status!=="stopped" || !proof.evidenceKey?.startsWith("v3/resource-stop/")) return unverified();
      } catch { return unverified(); }
    }
    let released;
    try{released=ResourceDecisionSchema.parse(await ports.releaseResources(request));}catch(error){quarantined=true;throw error;}
    if (released.permitId !== request.permitId || released.status !== "released") throw ApplicationFailure.nonRetryable("Resource release unverified", "RESOURCE.RELEASE_UNKNOWN");
    return value;
  };
}
