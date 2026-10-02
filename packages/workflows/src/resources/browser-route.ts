import {
  browserResourceOfQueue,
  browserResources,
  browserTaskQueue,
  type BrowserResourceId,
} from "@crawl-automation/platform/browser-routing";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";
import type { ResourceGate } from "@crawl-automation/v3-contracts";
import { ApplicationFailure, patched } from "@temporalio/workflow";

/** Keep the old gate and queue byte-for-byte on replay. New scans also take a host permit. */
export function browserRoute(at: {
  resources: ResourceGate | undefined;
  activity: string;
  queue: string;
  required: boolean;
}): { resources: ResourceGate | undefined; queue: string } {
  const needs = at.resources?.activities[at.activity] ?? [];
  const hosts = browserResources(needs.map((need) => need.resourceId));
  const queuedHost = browserResourceOfQueue(at.queue);
  if (!at.required && hosts.length === 0 && !queuedHost) {
    return at;
  }
  if (!patched("browser-resource-routing-v1")) {
    return at;
  }
  const resourceId = selectedHost(hosts, queuedHost);
  if (!at.resources) {
    throw ApplicationFailure.nonRetryable(
      "Browser resource routing is missing or ambiguous",
      resourceGateErrors.code("RESOURCE.BROWSER_ROUTE_INVALID"),
    );
  }
  // A declared permit wins over the workflow's host: workflow execution itself does not touch Ego.
  return {
    queue: browserTaskQueue(resourceId),
    resources: {
      ...at.resources,
      activities: {
        ...at.resources.activities,
        [at.activity]: hosts.length ? needs : [...needs, { resourceId, units: 1 }],
      },
    },
  };
}

function selectedHost(
  hosts: BrowserResourceId[],
  queuedHost?: BrowserResourceId,
): BrowserResourceId {
  const resourceId = hosts[0] ?? queuedHost;
  if (!resourceId || hosts.length > 1) {
    throw ApplicationFailure.nonRetryable(
      "Browser resource routing is missing or ambiguous",
      resourceGateErrors.code("RESOURCE.BROWSER_ROUTE_INVALID"),
    );
  }
  return resourceId;
}
