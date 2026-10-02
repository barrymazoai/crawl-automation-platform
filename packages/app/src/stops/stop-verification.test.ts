import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@crawl-automation/platform";
import { ResourceService } from "../resources/resource-service.js";
import type { HeldPermit } from "../runs/run-model.js";
import { StopVerification } from "./stop-verification.js";

function fixture() {
  const permit: HeldPermit = {
    permitId: "permit-one",
    workflowId: "workflow",
    runId: "exact-run",
    resources: ["ocr"],
    grantedAt: new Date(0).toISOString(),
    cleanup: {
      state: "CLEANUP_UNVERIFIED",
      attempts: 46,
      failure: { message: "original" },
      executions: [{ identity: { kind: "ocr", executionId: "job" }, stoppedAt: null, proof: null }],
    },
  };
  const resources = {
    findHeld: vi.fn(async () => permit),
    held: vi.fn(async () => [permit]),
    list: vi.fn(async () => []),
    release: vi.fn(async () => true),
  };
  const workflows = {
    stopEvidence: vi.fn(async () => ({
      workflowId: "workflow",
      status: "COMPLETED",
      closedAt: new Date(0),
      pendingActivities: 0,
    })),
  };
  const journal = {
    candidates: vi.fn(async () => [permit.permitId]),
    exclusive: async <T>(work: () => Promise<T>) => work(),
    attempted: vi.fn(),
    finish: vi.fn(async () => {
      if (permit.cleanup) {
        permit.cleanup.state = "stopped";
      }
    }),
  };
  const verifier = {
    verify: vi.fn(async () => [{ executionId: "job", kind: "ocr", stopped: true }]),
  };
  const log = createLogger({ name: "stop-test", level: "fatal" });
  const stopVerification = new StopVerification({ resources, workflows, journal, verifier, log });
  const service = new ResourceService({ resources, workflows, log, stopVerification });
  return { permit, resources, workflows, journal, verifier, service };
}

describe("exact-owner permit stop recovery", () => {
  it("checks the exact closed owner again before release, preserves original failure", async () => {
    const test = fixture();
    expect(await test.service.verifyStop("permit-one")).toMatchObject({ released: true });
    expect(test.workflows.stopEvidence.mock.calls).toEqual([
      ["workflow", "exact-run"],
      ["workflow", "exact-run"],
    ]);
    expect(test.permit.cleanup?.failure).toEqual({ message: "original" });
    expect(test.journal.attempted).toHaveBeenCalledWith(test.permit);
    expect(test.resources.release).toHaveBeenCalledWith("permit-one");
  });

  it("refuses a running owner before executing any stop request", async () => {
    const test = fixture();
    test.workflows.stopEvidence.mockResolvedValue({
      workflowId: "workflow",
      status: "RUNNING",
      closedAt: new Date(0),
      pendingActivities: 0,
    });
    await expect(test.service.verifyStop("permit-one")).rejects.toMatchObject({
      code: "PERMIT.OWNER_RUNNING",
    });
    expect(test.verifier.verify).not.toHaveBeenCalled();
    expect(test.journal.attempted).not.toHaveBeenCalled();
  });

  it("keeps the permit unless every recorded execution is proven", async () => {
    const test = fixture();
    test.verifier.verify.mockResolvedValue([
      { executionId: "job", kind: "ocr", stopped: true },
      { executionId: "another", kind: "ocr", stopped: false },
    ]);
    expect(await test.service.verifyStop("permit-one")).toMatchObject({ released: false });
    expect(test.journal.finish).not.toHaveBeenCalled();
    expect(test.resources.release).not.toHaveBeenCalled();
  });

  it("does not manufacture stop proof for missing legacy identities", async () => {
    const test = fixture();
    test.verifier.verify.mockResolvedValue([]);
    expect(await test.service.verifyStop("permit-one")).toMatchObject({
      reason: "execution_identity_missing",
    });
    expect(test.resources.release).not.toHaveBeenCalled();
  });

  it("a sweep is bounded, rotates candidates, skips running owners and continues after errors", async () => {
    const test = fixture();
    test.journal.candidates.mockResolvedValue(["running", "closed"]);
    test.workflows.stopEvidence.mockResolvedValueOnce({
      workflowId: "workflow",
      status: "RUNNING",
      closedAt: new Date(0),
      pendingActivities: 1,
    });
    const answer = await test.service.verifyStops();
    expect(answer.results).toHaveLength(2);
    expect(answer.results[0]?.reason).toBe("PERMIT.OWNER_RUNNING");
    expect(test.verifier.verify).toHaveBeenCalledOnce();
    expect(test.journal.candidates).toHaveBeenLastCalledWith(20, "");
    await test.service.verifyStops();
    expect(test.journal.candidates).toHaveBeenLastCalledWith(20, "closed");
  });

  it("a concurrent verifier cannot run a second close request", async () => {
    const test = fixture();
    test.journal.exclusive = async () => null as never;
    expect(await test.service.verifyStop("permit-one")).toMatchObject({
      reason: "verification_busy",
    });
    expect(test.verifier.verify).not.toHaveBeenCalled();
  });

  it("cannot release if the second Temporal observation is unavailable", async () => {
    const test = fixture();
    test.workflows.stopEvidence
      .mockResolvedValueOnce({
        workflowId: "workflow",
        status: "COMPLETED",
        closedAt: new Date(0),
        pendingActivities: 0,
      })
      .mockRejectedValueOnce(new Error("Temporal unavailable"));
    await expect(test.service.verifyStop("permit-one")).rejects.toThrow("Temporal unavailable");
    expect(test.resources.release).not.toHaveBeenCalled();
  });
});

it("wraps the bounded cursor in the same sweep so pending work is checked every interval", async () => {
  const test = fixture();
  test.verifier.verify.mockResolvedValue([{ executionId: "job", kind: "ocr", stopped: false }]);
  await test.service.verifyStops();
  test.journal.candidates.mockResolvedValueOnce([]).mockResolvedValueOnce(["permit-one"]);
  expect((await test.service.verifyStops()).results).toHaveLength(1);
  expect(test.journal.candidates.mock.calls.slice(-2)).toEqual([
    [20, "permit-one"],
    [20, ""],
  ]);
});
