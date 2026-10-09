import { ResourceDecisionSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";
import { log, proxyActivities } from "@temporalio/workflow";
import { resourceFailure } from "./resource-failure.js";

type ReleaseRequest = ResourceRequest & { reserveFailed?: true };

export interface ResourceActivities {
  reserveResources(request: ResourceRequest): Promise<unknown>;
  releaseResources(request: ReleaseRequest): Promise<unknown>;
  prepareResourceExecution(request: ResourceRequest): Promise<unknown>;
  stopResourceExecution(
    request: ResourceRequest & {
      cleanupFailure: Record<string, unknown> | null;
    },
  ): Promise<unknown>;
}

export function resourceActivities(queue: string): ResourceActivities {
  const options = {
    taskQueue: queue,
    startToCloseTimeout: "10 seconds",
    scheduleToCloseTimeout: "45 seconds",
  };
  const reserve = proxyActivities<ResourceActivities>({
    ...options,
    retry: { maximumAttempts: 1 },
  });
  // Exact-request release uses a row lock and coalesce(released_at, now()). Repeating it is safe.
  const release = proxyActivities<ResourceActivities>({
    ...options,
    retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "5 seconds" },
  });
  return {
    reserveResources: reserve.reserveResources,
    releaseResources: release.releaseResources,
    prepareResourceExecution: release.prepareResourceExecution,
    stopResourceExecution: reserve.stopResourceExecution,
  };
}

export async function releasePermit(ports: ResourceActivities, request: ReleaseRequest) {
  const result = ResourceDecisionSchema.safeParse(await ports.releaseResources(request));
  if (
    !result.success ||
    result.data.permitId !== request.permitId ||
    result.data.status !== "released"
  ) {
    throw resourceFailure("RESOURCE.RELEASE_UNKNOWN", { request });
  }
  log.info("resource permit released", { ...request, releasedAt: Date.now() });
}
