import type { ResourceGate, ResourceRequest } from "@crawl-automation/v3-contracts";
import { sleep } from "@temporalio/workflow";
import { z } from "zod";
import { releasePermit, type ResourceActivities } from "./resource-activities.js";
import { resourceFailure } from "./resource-failure.js";

const StopReply = z.object({ permitId: z.string(), state: z.string(), attempts: z.number() });

/** Poll only the stop journal. The business Activity is never retried or replaced by cleanup. */
export async function stopAndReleasePermit(at: {
  ports: ResourceActivities;
  request: ResourceRequest;
  config: ResourceGate;
  failure: Record<string, unknown> | null;
}) {
  const { ports, request, failure, config } = at;
  const deadline = Date.now() + (config.stopVerificationSeconds ?? 150) * 1000;
  for (;;) {
    const reply = StopReply.safeParse(
      await ports.stopResourceExecution({ ...request, cleanupFailure: failure }),
    );
    if (!reply.success || reply.data.permitId !== request.permitId) {
      throw resourceFailure("RESOURCE.CLEANUP_UNVERIFIED", { request });
    }
    if (reply.data.state === "stopped") {
      return releasePermit(ports, request);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min((config.stopVerificationPollSeconds ?? 5) * 1000, remaining));
  }
  throw resourceFailure("RESOURCE.CLEANUP_UNVERIFIED", {
    request,
    recovery:
      "Inspect held permit execution identities and complete exact-owner stop verification.",
  });
}
