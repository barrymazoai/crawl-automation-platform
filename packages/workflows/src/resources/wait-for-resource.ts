import {
  ResourceDecisionSchema,
  type ResourceGate,
  type ResourceRequest,
} from "@crawl-automation/v3-contracts";
import { CancellationScope, log, patched, sleep } from "@temporalio/workflow";
import type { ResourceActivities } from "./resource-activities.js";
import type { ResourceGrant } from "./resource-binding.js";
import { resourceFailure } from "./resource-failure.js";

/** Reserve is shielded so cancellation cannot hide a committed grant before finally owns it. */
export async function waitForResource(at: {
  config: ResourceGate;
  request: ResourceRequest;
  ports: ResourceActivities;
  waiting: { polls: number };
}): Promise<ResourceGrant | undefined> {
  const requestedAt = Date.now();
  const deadline = requestedAt + at.config.maxWaitSeconds * 1000;
  log.info("resource permit requested", { ...at.request, requestedAt });
  for (;;) {
    const result = ResourceDecisionSchema.safeParse(
      await CancellationScope.nonCancellable(() => at.ports.reserveResources(at.request)),
    );
    if (!result.success || invalidDecision(result.data, at.request.permitId)) {
      throw resourceFailure("RESOURCE.IDENTITY_CONFLICT", { request: at.request });
    }
    if (result.data.status === "granted") {
      log.info("resource permit granted", {
        ...at.request,
        requestedAt,
        grantedAt: Date.now(),
        waitMs: Date.now() - requestedAt,
        host: result.data.host,
      });
      return result.data.host ? { host: result.data.host } : undefined;
    }
    if (await waitForBrowser(result.data.reason)) {
      continue;
    }
    at.waiting.polls++;
    // Keep the current scheduling policy: occupied healthy capacity backs off; unhealthy capacity
    // consumes maxWaitSeconds. The gate-wide poll budget also bounds healthy waiting.
    if (at.waiting.polls >= 400 || (result.data.reason !== "capacity" && Date.now() >= deadline)) {
      throw resourceFailure("RESOURCE.WAIT_LIMIT", {
        executionFact: "not_executed",
        reason: result.data.reason,
        request: at.request,
      });
    }
    await sleep(pollDelay(at.waiting.polls));
  }
}

function pollDelay(polls: number): number {
  return polls < 30 ? 10_000 : polls < 120 ? 30_000 : 60_000;
}

/** Browser availability is infrastructure waiting, never a consumed business attempt. */
async function waitForBrowser(reason: string): Promise<boolean> {
  if (!reason.startsWith("browser:") || !patched("browser-resource-outage-wait-v1")) {
    return false;
  }
  await sleep(10_000);
  return true;
}

function invalidDecision(result: { permitId: string; status: string }, permitId: string): boolean {
  return result.permitId !== permitId || result.status === "released";
}
