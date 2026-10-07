import type { PermitOwner } from "@crawl-automation/platform";
import { defaultPayloadConverter } from "@temporalio/common";
import type { temporal } from "@temporalio/proto";

/** After its reservation, only these may run for a permit whose gated work never started. */
const AFTER_RESERVE = new Set(["releaseResources", "stopResourceExecution"]);

type HistoryEvent = temporal.api.history.v1.IHistoryEvent;

/**
 * Owner 2026-10-07: whether a closed owner may have run work under this permit. The reservation is found by its
 * exact permit id; after it, any Activity scheduled with the permit id or of any type other than release/stop counts
 * as work. A history without that reservation is unknown and also counts as work, so the permit stays held.
 */
export function permitWorkScheduled(events: HistoryEvent[], owner: PermitOwner): boolean {
  let reserved = false;
  for (const event of events) {
    const scheduled = event.activityTaskScheduledEventAttributes;
    if (!scheduled) {
      continue;
    }
    const type = scheduled.activityType?.name ?? "";
    if (!reserved) {
      reserved = type === "reserveResources" && reservedPermit(scheduled) === owner.permitId;
      continue;
    }
    if (scheduled.activityId === owner.permitId || !AFTER_RESERVE.has(type)) {
      return true;
    }
  }
  return !reserved;
}

function reservedPermit(
  scheduled: temporal.api.history.v1.IActivityTaskScheduledEventAttributes,
): unknown {
  const payload = scheduled.input?.payloads?.[0];
  try {
    const request = payload ? defaultPayloadConverter.fromPayload(payload) : null;
    return (request as { permitId?: unknown } | null)?.permitId;
  } catch {
    return undefined;
  }
}
