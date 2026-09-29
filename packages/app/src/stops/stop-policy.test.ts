import { describe, expect, it } from "vitest";
import { stopVerdict, type StopEvidence } from "./stop-policy.js";

const now = new Date("2026-09-29T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function evidence(overrides: Partial<StopEvidence>): StopEvidence {
  return {
    workflowId: "product-1",
    status: "CANCELLED",
    closedAt: minutesAgo(10),
    pendingActivities: 0,
    ...overrides,
  };
}

describe("stopVerdict", () => {
  it("proves a stop: closed, nothing pending, closed five minutes ago or more", () => {
    expect(stopVerdict(evidence({}), now)).toBe("stopped");
    expect(stopVerdict(evidence({ status: "COMPLETED", closedAt: minutesAgo(5) }), now)).toBe(
      "stopped",
    );
  });

  it("reports a running workflow as running", () => {
    expect(stopVerdict(evidence({ status: "RUNNING", closedAt: null }), now)).toBe("running");
  });

  it("does not prove a stop while an Activity is pending", () => {
    expect(stopVerdict(evidence({ pendingActivities: 1 }), now)).toBe("not-proven");
  });

  it("does not prove a stop right after the close", () => {
    expect(stopVerdict(evidence({ closedAt: minutesAgo(2) }), now)).toBe("not-proven");
  });

  it("does not treat a workflow Temporal cannot find as stopped", () => {
    expect(stopVerdict(null, now)).toBe("not-proven");
  });
});
