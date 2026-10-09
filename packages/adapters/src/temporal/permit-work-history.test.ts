import { defaultPayloadConverter } from "@temporalio/common";
import { temporal } from "@temporalio/proto";
import { describe, expect, it } from "vitest";
import { permitWorkScheduled } from "./permit-work-history.js";

const owner = { permitId: "permit-a-0", workflowId: "wf", runId: "run" };

function scheduled(activityId: string, type: string, input?: unknown) {
  return {
    activityTaskScheduledEventAttributes: {
      activityId,
      activityType: { name: type },
      input: input === undefined ? null : { payloads: [defaultPayloadConverter.toPayload(input)] },
    },
  };
}

describe("permit work history (owner 2026-10-07)", () => {
  const reserve = scheduled("2", "reserveResources", { permitId: "permit-a-0" });

  it("proves no work when only stop/release follow this permit's reservation", () => {
    const events = [
      scheduled("1", "prepareProductEnrichment"),
      reserve,
      scheduled("4", "stopResourceExecution"),
      scheduled("5", "releaseResources"),
    ];
    expect(permitWorkScheduled(events, owner)).toBe(false);
  });

  it("counts the gated activity, any other activity type, or an unknown history as work", () => {
    expect(permitWorkScheduled([reserve, scheduled("permit-a-0", "enrichProduct")], owner)).toBe(
      true,
    );
    expect(permitWorkScheduled([reserve, scheduled("3", "prepareResourceExecution")], owner)).toBe(
      true,
    );
    expect(
      permitWorkScheduled(
        [scheduled("2", "reserveResources", { permitId: "permit-other-0" })],
        owner,
      ),
    ).toBe(true);
    expect(permitWorkScheduled([], owner)).toBe(true);
  });
});

describe("reservation outcomes (owner 2026-10-09)", () => {
  const { HistoryEvent } = temporal.api.history.v1;
  const reserve = HistoryEvent.fromObject({
    eventId: "13",
    ...scheduled("13", "reserveResources", owner),
  });
  const completed = HistoryEvent.fromObject({
    eventId: "15",
    activityTaskCompletedEventAttributes: { scheduledEventId: "13" },
  });
  const timedOut = HistoryEvent.fromObject({
    eventId: "15",
    activityTaskTimedOutEventAttributes: { scheduledEventId: "13", startedEventId: "14" },
  });
  const work = scheduled(owner.permitId, "enrichProduct");
  const review = scheduled("19", "reviewProductEnrichment");

  it("handles the production timeout followed by a failed Review and workflow completion", () => {
    const leaked = { ...owner, permitId: "permit-01a11a15-d703-795b-9372-576fa9f83ae4-0" };
    const reservation = scheduled("13", "reserveResources", leaked);
    const events = [
      HistoryEvent.fromObject({
        eventId: "13",
        activityTaskScheduledEventAttributes: {
          ...reservation.activityTaskScheduledEventAttributes,
          taskQueue: { name: "v3.resources.v1" },
          startToCloseTimeout: { seconds: "10" },
        },
      }),
      HistoryEvent.fromObject({
        eventId: "14",
        activityTaskStartedEventAttributes: { scheduledEventId: "13" },
      }),
      timedOut,
      HistoryEvent.fromObject({ eventId: "19", ...review }),
      HistoryEvent.fromObject({
        eventId: "21",
        activityTaskFailedEventAttributes: { scheduledEventId: "19" },
      }),
      HistoryEvent.fromObject({ eventId: "25", workflowExecutionCompletedEventAttributes: {} }),
    ];
    expect(permitWorkScheduled(events, leaked)).toBe(false);
  });

  it.each(["activityTaskFailedEventAttributes", "activityTaskCanceledEventAttributes"])(
    "proves no work after a reservation ends with %s",
    (attribute) => {
      const outcome = HistoryEvent.fromObject({ [attribute]: { scheduledEventId: "13" } });
      expect(permitWorkScheduled([reserve, outcome, review], owner)).toBe(false);
    },
  );

  it("uses the last completed reservation of the same permit after a timeout", () => {
    const retried = HistoryEvent.fromObject({
      eventId: "20",
      ...scheduled("20", "reserveResources", owner),
    });
    const outcome = HistoryEvent.fromObject({
      eventId: "22",
      activityTaskCompletedEventAttributes: { scheduledEventId: "20" },
    });
    const events = [reserve, timedOut, review, retried, outcome];
    expect(permitWorkScheduled([...events, work], owner)).toBe(true);
    expect(permitWorkScheduled([...events, scheduled("23", "releaseResources")], owner)).toBe(
      false,
    );
  });

  it("uses the last failed reservation even if an earlier poll completed", () => {
    const earlier = HistoryEvent.fromObject({
      eventId: "2",
      ...scheduled("2", "reserveResources", owner),
    });
    const outcome = HistoryEvent.fromObject({
      eventId: "4",
      activityTaskCompletedEventAttributes: { scheduledEventId: "2" },
    });
    expect(permitWorkScheduled([earlier, outcome, reserve, timedOut, review], owner)).toBe(false);
  });

  it.each([
    "workflowExecutionCompletedEventAttributes",
    "workflowExecutionFailedEventAttributes",
    "workflowExecutionCanceledEventAttributes",
    "workflowExecutionTimedOutEventAttributes",
    "workflowExecutionTerminatedEventAttributes",
    "workflowExecutionContinuedAsNewEventAttributes",
  ])("proves no work without reservation completion when the run ends with %s", (attribute) => {
    const closed = HistoryEvent.fromObject({ [attribute]: {} });
    expect(permitWorkScheduled([reserve, review, closed], owner)).toBe(false);
    expect(permitWorkScheduled([review, closed], owner)).toBe(true);
  });

  it("matches outcomes by scheduledEventId, not activity order or another permit", () => {
    const other = HistoryEvent.fromObject({
      eventId: "20",
      ...scheduled("20", "reserveResources", { permitId: "other-permit" }),
    });
    const failed = HistoryEvent.fromObject({
      activityTaskFailedEventAttributes: { scheduledEventId: "20" },
    });
    expect(permitWorkScheduled([reserve, completed, other, failed, work], owner)).toBe(true);
    expect(permitWorkScheduled([reserve, failed, review], owner)).toBe(true);
  });

  it("still counts any work after completion, including a stop with this permit's activityId", () => {
    expect(permitWorkScheduled([reserve, completed, review], owner)).toBe(true);
    expect(
      permitWorkScheduled(
        [reserve, completed, scheduled(owner.permitId, "stopResourceExecution")],
        owner,
      ),
    ).toBe(true);
    expect(
      permitWorkScheduled([reserve, completed, scheduled("16", "stopResourceExecution")], owner),
    ).toBe(false);
  });
});
