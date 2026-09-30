import { ResourceGateSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";
import { ActivityCancellationType, CancellationScope, workflowInfo } from "@temporalio/workflow";
import { releasePermit, resourceActivities } from "./resource-activities.js";
import { waitForResource } from "./wait-for-resource.js";

export interface ResourceActivityBinding {
  activityId: string;
  cancellationType: typeof ActivityCancellationType.WAIT_CANCELLATION_COMPLETED;
  heartbeatTimeout?: "30 seconds";
}

export type GatedWork<T> = (binding?: ResourceActivityBinding) => Promise<T>;

/**
 * One permit per step. Activity cancellation waits for acknowledgement; activity/scope timeouts also
 * enter finally. Server-enforced workflow termination/timeouts cannot execute workflow cleanup.
 */
export function resourceGate(raw: unknown) {
  const config = raw === undefined ? undefined : ResourceGateSchema.parse(raw);
  let sequence = 0;
  const waiting = { polls: 0 };
  return async <Result>(name: string, run: GatedWork<Result>): Promise<Result> => {
    const needs = config?.activities[name];
    if (!config || !needs) {
      return run();
    }
    const info = workflowInfo();
    const request: ResourceRequest = {
      permitId: `permit-${info.runId}-${sequence++}`,
      workflowId: info.workflowId,
      runId: info.runId,
      needs,
    };
    const ports = resourceActivities(config.queue);
    await waitForResource({ config, request, ports, waiting });
    try {
      return await run({
        activityId: request.permitId,
        cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
        heartbeatTimeout: "30 seconds",
      });
    } finally {
      await CancellationScope.nonCancellable(() => releasePermit(ports, request));
    }
  };
}
