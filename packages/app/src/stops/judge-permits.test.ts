import { describe, expect, it, vi } from "vitest";
import type { HeldPermit } from "../runs/run-model.js";
import { judgePermits } from "./judge-permits.js";
import type { StopEvidence } from "./stop-policy.js";

const now = new Date("2026-09-30T10:00:00Z");
const stopped: StopEvidence = {
  workflowId: "workflow",
  status: "COMPLETED",
  closedAt: new Date(now.getTime() - 300_000),
  pendingActivities: 0,
};
const permit = (permitId: string, changes: Partial<HeldPermit> = {}): HeldPermit => ({
  permitId,
  workflowId: "workflow",
  runId: "run-one",
  resources: ["model"],
  grantedAt: "2026-09-30T09:00:00Z",
  cleanup: { state: "stopped", attempts: 1, failure: null, executions: [] },
  ...changes,
});

describe("judgePermits", () => {
  it("does not ask for stop evidence when there are no permits", async () => {
    const stopEvidence = vi.fn();
    expect(await judgePermits([], { stopEvidence }, now)).toEqual([]);
    expect(stopEvidence).not.toHaveBeenCalled();
  });

  it("asks once per exact owner execution and preserves permit order and references", async () => {
    const permits = [permit("one"), permit("two", { runId: "run-two" }), permit("three")];
    const stopEvidence = vi.fn(async (_workflow: string, runId: string) =>
      runId === "run-one" ? stopped : { ...stopped, status: "RUNNING" },
    );
    const result = await judgePermits(permits, { stopEvidence }, now);
    expect(stopEvidence.mock.calls).toEqual([
      ["workflow", "run-one"],
      ["workflow", "run-two"],
    ]);
    expect(result.map((item) => item.verdict)).toEqual(["stopped", "running", "stopped"]);
    result.forEach((item, index) => expect(item.permit).toBe(permits[index]));
  });

  it("keeps different workflows separate even when their run IDs match", async () => {
    const stopEvidence = vi.fn(async () => null);
    const permits = [permit("one"), permit("two", { workflowId: "other" })];
    await judgePermits(permits, { stopEvidence }, now);
    expect(stopEvidence.mock.calls).toEqual([
      ["workflow", "run-one"],
      ["other", "run-one"],
    ]);
  });

  it.each([
    [null, "not-proven"],
    [{ ...stopped, status: "RUNNING" }, "running"],
    [{ ...stopped, closedAt: null }, "not-proven"],
    [{ ...stopped, pendingActivities: 1 }, "not-proven"],
    [{ ...stopped, closedAt: new Date(now.getTime() - 299_999) }, "stopped"],
    [{ ...stopped, closedAt: new Date(now.getTime() + 1) }, "not-proven"],
    [stopped, "stopped"],
    [{ ...stopped, status: "FAILED" }, "stopped"],
  ] as const)("maps stop evidence %j to %s", async (evidence, verdict) => {
    const stopEvidence = vi.fn(async () => evidence);
    const held = permit("one");
    expect(await judgePermits([held, held], { stopEvidence }, now)).toEqual([
      { permit: held, verdict },
      { permit: held, verdict },
    ]);
    expect(stopEvidence).toHaveBeenCalledOnce();
  });

  it("propagates gateway failures without guessing or retrying", async () => {
    const failure = new Error("Temporal unavailable");
    const stopEvidence = vi.fn().mockRejectedValue(failure);
    await expect(judgePermits([permit("one")], { stopEvidence }, now)).rejects.toBe(failure);
    expect(stopEvidence).toHaveBeenCalledOnce();
  });

  it("requires proof for each permit even when they share a closed workflow", async () => {
    const unknown = permit("unknown", {
      cleanup: { state: "CLEANUP_UNVERIFIED", attempts: 3, failure: null, executions: [] },
    });
    const legacy = permit("legacy");
    delete legacy.cleanup;
    const result = await judgePermits(
      [permit("proved"), unknown, legacy],
      {
        stopEvidence: async () => stopped,
      },
      now,
    );
    expect(result.map(({ verdict }) => verdict)).toEqual(["stopped", "not-proven", "not-proven"]);
  });
});
