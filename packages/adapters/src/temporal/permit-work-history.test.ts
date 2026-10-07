import { defaultPayloadConverter } from "@temporalio/common";
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
