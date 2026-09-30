import {
  ResourceDecisionSchema,
  type ResourceGate,
  type ResourceRequest,
} from "@crawl-automation/v3-contracts";
import { CancellationScope, sleep } from "@temporalio/workflow";
import type { ResourceActivities } from "./resource-activities.js";
import { resourceFailure } from "./resource-failure.js";

/** Reserve is shielded so cancellation cannot hide a committed grant before finally owns it. */
export async function waitForResource(at: {
  config: ResourceGate;
  request: ResourceRequest;
  ports: ResourceActivities;
  waiting: { polls: number };
}): Promise<void> {
  const deadline = Date.now() + at.config.maxWaitSeconds * 1000;
  for (;;) {
    const result = ResourceDecisionSchema.safeParse(
      await CancellationScope.nonCancellable(() => at.ports.reserveResources(at.request)),
    );
    if (
      !result.success ||
      result.data.permitId !== at.request.permitId ||
      result.data.status === "released"
    ) {
      throw resourceFailure("RESOURCE.IDENTITY_CONFLICT", { request: at.request });
    }
    if (result.data.status === "granted") {
      return;
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
