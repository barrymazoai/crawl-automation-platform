import { proxyActivities, sleep, workflowInfo, ApplicationFailure, patched } from "@temporalio/workflow";
import { ResourceGateSchema, ResourceDecisionSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";

export function resourceGate(raw: unknown, options:{requireReviewStop?:boolean}={}) {
  const config = raw === undefined ? undefined : ResourceGateSchema.parse(raw);
  let sequence = 0;
  return async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const needs = config?.activities[name]; if (!config || !needs) return run();
    const info = workflowInfo();
    const request: ResourceRequest = { permitId: `permit-${info.runId}-${sequence++}`, workflowId: info.workflowId, runId: info.runId, needs };
    const ports = proxyActivities<{ reserveResources(r: ResourceRequest): Promise<unknown>; releaseResources(r: ResourceRequest): Promise<unknown> }>({
      // These are idempotent control-ledger calls, not provider/model retries.
      taskQueue: config.queue, startToCloseTimeout: "10 seconds", scheduleToCloseTimeout: "45 seconds", retry: { maximumAttempts: 3 } });
    const until = Date.now() + config.maxWaitSeconds * 1000;
    const waitForCapacity = patched("resource-capacity-wait-v1");
    let unhealthySince: number | undefined;
    for (;;) {
      const result = ResourceDecisionSchema.parse(await ports.reserveResources(request));
      if (result.permitId !== request.permitId || result.status === "released") throw ApplicationFailure.nonRetryable("Resource identity conflict", "RESOURCE.IDENTITY_CONFLICT");
      if (result.status === "granted") break;
      // Occupied but healthy capacity is normal scheduling, not a product failure.
      // Preserve the old deadline on replay; only consecutive unhealthy time counts
      // against the new dependency budget. No business Activity has started yet.
      if (waitForCapacity) {
        if (result.reason === "capacity") unhealthySince = undefined;
        else unhealthySince ??= Date.now();
      }
      if (waitForCapacity ? unhealthySince !== undefined && Date.now() - unhealthySince >= config.maxWaitSeconds * 1000 : Date.now() >= until)
        throw ApplicationFailure.nonRetryable("Resource unavailable; no business execution started", "RESOURCE.WAIT_LIMIT");
      await sleep("10 seconds");
    }
    // An Activity timeout/cancel may leave external work alive. Do NOT release in finally.
    // Such permits remain quarantined until a separate evidence-based recovery proves the owner stopped.
    const value = await run();
    // A Review receipt proves classification, not that external execution has stopped.
    // Preserve the result for downstream Review handling, but quarantine its permit.
    // Old histories retain their original command sequence during replay.
    if (patched("resource-review-quarantine-v1") && value && typeof value === "object" && "status" in value && value.status === "review") {
      const unverified=()=>{if(options.requireReviewStop)throw ApplicationFailure.nonRetryable("Review execution stop unverified","RESOURCE.REVIEW_STOP_UNVERIFIED");return value;};
      if (!config.reviewStopCheck || !patched("resource-review-stop-proof-v1")) return unverified();
      // Only an explicit verifier may attest to a stopped execution. A Review
      // boolean, error code, timeout or missing receipt alone is never sufficient.
      const verifier = proxyActivities<{ verifyResourceReviewStopped(raw: unknown): Promise<unknown> }>({
        taskQueue: config.queue, startToCloseTimeout: "30 seconds", scheduleToCloseTimeout: "45 seconds", retry: { maximumAttempts: 1 } });
      try {
        const proof = await verifier.verifyResourceReviewStopped({request,activityName:name,outcome:value}) as {permitId?:string;status?:string;evidenceKey?:string};
        if (proof?.permitId!==request.permitId || proof.status!=="stopped" || !proof.evidenceKey?.startsWith("v3/resource-stop/")) return unverified();
      } catch { return unverified(); }
    }
    const released = ResourceDecisionSchema.parse(await ports.releaseResources(request));
    if (released.permitId !== request.permitId || released.status !== "released") throw ApplicationFailure.nonRetryable("Resource release unverified", "RESOURCE.RELEASE_UNKNOWN");
    return value;
  };
}
