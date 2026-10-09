import type { PermitOwner } from "@crawl-automation/platform";
import { defaultPayloadConverter } from "@temporalio/common";
import type { temporal } from "@temporalio/proto";

/** After its reservation, only these may run for a permit whose gated work never started. */
const AFTER_RESERVE = new Set(["releaseResources", "stopResourceExecution"]);

type HistoryEvent = temporal.api.history.v1.IHistoryEvent;

/**
 * Owner 2026-10-09: use the LAST reservation for this exact permit id, matching its outcome by scheduledEventId.
 * A timed-out, failed or canceled reservation, or one without completion in a closed run, never delivered the grant.
 * After a completed reservation, any Activity with the permit id or a type other than release/stop counts as work.
 * Unknown history without a matching reservation still counts as work; unfinished open histories keep the old rules.
 */
export function permitWorkScheduled(events: HistoryEvent[], owner: PermitOwner): boolean {
  const reservation = events.findLastIndex((event) => {
    const scheduled = event.activityTaskScheduledEventAttributes;
    return (
      scheduled?.activityType?.name === "reserveResources" &&
      reservedPermit(scheduled) === owner.permitId
    );
  });
  if (reservation < 0) {
    return true;
  }
  const following = events.slice(reservation + 1);
  const outcome = following.findIndex((event) =>
    reservationOutcome(event, events[reservation]?.eventId),
  );
  if (outcome >= 0) {
    return (
      Boolean(following[outcome]?.activityTaskCompletedEventAttributes) &&
      following.slice(outcome + 1).some((event) => workScheduled(event, owner.permitId))
    );
  }
  return (
    !following.some(workflowClosed) &&
    following.some((event) => workScheduled(event, owner.permitId))
  );
}

function reservationOutcome(event: HistoryEvent, eventId: HistoryEvent["eventId"]): boolean {
  const outcome =
    event.activityTaskCompletedEventAttributes ??
    event.activityTaskTimedOutEventAttributes ??
    event.activityTaskFailedEventAttributes ??
    event.activityTaskCanceledEventAttributes;
  return eventId != null && outcome?.scheduledEventId?.toString() === eventId.toString();
}

function workflowClosed(event: HistoryEvent): boolean {
  return Boolean(
    event.workflowExecutionCompletedEventAttributes ??
    event.workflowExecutionFailedEventAttributes ??
    event.workflowExecutionCanceledEventAttributes ??
    event.workflowExecutionTimedOutEventAttributes ??
    event.workflowExecutionTerminatedEventAttributes ??
    event.workflowExecutionContinuedAsNewEventAttributes,
  );
}

function workScheduled(event: HistoryEvent, permitId: string): boolean {
  const scheduled = event.activityTaskScheduledEventAttributes;
  return Boolean(
    scheduled &&
    (scheduled.activityId === permitId || !AFTER_RESERVE.has(scheduled.activityType?.name ?? "")),
  );
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
