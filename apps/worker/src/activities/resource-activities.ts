import { reserveWithBrowserHealth } from "../resources/browser-health.js";
import { withCause } from "@crawl-automation/platform";
import { activityLogger } from "./activity-log.js";
import { contextualActivity } from "./activity-context-handler.js";
import { errorCodeOf } from "@crawl-automation/platform";
import { resourceGateCodes } from "@crawl-automation/platform/errors/resource-gate";
import { ApplicationFailure } from "@temporalio/common";
import { PostgresPermitStop } from "@crawl-automation/adapters";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";

/** Resource permits for the workflows' permit gates: short ledger transactions, never a wait. */
export function resourceActivities(parts: WorkerParts) {
  const stops = new PostgresPermitStop(parts.database);
  return {
    prepareResourceExecution: contextualActivity(
      "prepareResourceExecution",
      (raw) => stops.prepare(raw),
      parts.log,
    ),
    stopResourceExecution: contextualActivity(
      "stopResourceExecution",
      (raw) => stops.verify(raw),
      parts.log,
    ),
    reserveResources: guarded(
      "reserveResources",
      (raw, signal) =>
        reserveWithBrowserHealth({
          parts,
          raw,
          signal,
          reserve: (value) => parts.admission.reserve(value),
        }),
      parts.log,
    ),
    releaseResources: contextualActivity(
      "releaseResources",
      (raw) => releaseResource(parts, raw),
      parts.log,
    ),
  };
}

/** Release alone can repeat: the ledger checks the exact request and preserves released_at. */
async function releaseResource(parts: WorkerParts, raw: unknown): Promise<unknown> {
  const log = activityLogger(parts.log, "releaseResources", raw);
  try {
    const result = await parts.admission.release(raw);
    log.info("resource permit released");
    return result;
  } catch (error) {
    const code = errorCodeOf(error) ?? resourceGateCodes.releaseUnknown;
    log.error({ err: error, code }, "resource release failed");
    throw withCause(
      ApplicationFailure.create({
        message: "Resource release failed",
        type: code,
        nonRetryable:
          code === resourceGateCodes.identityConflict ||
          code === resourceGateCodes.cleanupUnverified,
      }),
      error,
    );
  }
}
