import type { ResourceGate, ResourceRequest } from "@crawl-automation/v3-contracts";
import { ActivityCancellationType, CancellationScope, patched } from "@temporalio/workflow";
import { releasePermit, type ResourceActivities } from "./resource-activities.js";
import type { GatedWork } from "./resource-binding.js";
import { stopAndReleasePermit } from "./stop-permit.js";
import { needsStopProof, unknownExecutionFailure } from "./execution-outcome.js";

export async function executePermit<Result>(
  at: { request: ResourceRequest; ports: ResourceActivities; config: ResourceGate },
  run: GatedWork<Result>,
): Promise<Result> {
  let proofRequired = false;
  let failure: Record<string, unknown> | null = null;
  try {
    const result = await run({
      activityId: at.request.permitId,
      cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
      heartbeatTimeout: "30 seconds",
    });
    proofRequired = needsStopProof(result);
    return result;
  } catch (error) {
    failure = { message: String(error) };
    proofRequired = unknownExecutionFailure(error);
    throw error;
  } finally {
    await CancellationScope.nonCancellable(() => settlePermit({ ...at, failure, proofRequired }));
  }
}

async function settlePermit(at: {
  request: ResourceRequest;
  ports: ResourceActivities;
  config: ResourceGate;
  failure: Record<string, unknown> | null;
  proofRequired: boolean;
}) {
  if (at.proofRequired && patched("resource-execution-stop-proof-v1")) {
    return stopAndReleasePermit(at);
  }
  try {
    // The existing release transaction also refuses unresolved executor/page receipts.
    await releasePermit(at.ports, at.request);
  } catch (error) {
    if (!needsStopProof(error) || !patched("resource-execution-stop-proof-v1")) {
      throw error;
    }
    return stopAndReleasePermit(at);
  }
}
