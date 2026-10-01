import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import { ActivityCancellationType, CancellationScope } from "@temporalio/workflow";
import { releasePermit, type ResourceActivities } from "../resource-activities.js";
import type { GatedWork } from "../resource-gate.js";

/** Pre-R59 command sequence, used only to generate an in-memory replay history. */
export async function executePermit<Result>(
  { request, ports }: { request: ResourceRequest; ports: ResourceActivities },
  run: GatedWork<Result>,
) {
  try {
    return await run({
      activityId: request.permitId,
      cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
      heartbeatTimeout: "30 seconds",
    });
  } finally {
    await CancellationScope.nonCancellable(() => releasePermit(ports, request));
  }
}
