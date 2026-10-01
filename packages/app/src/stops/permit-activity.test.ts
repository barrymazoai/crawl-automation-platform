import { describe, expect, it, vi } from "vitest";
import {
  createLogger,
  currentPermitExecution,
  recordPermitExecution,
  provePermitExecutionStopped,
  type PermitExecutionIdentity,
} from "@crawl-automation/platform";
import { ResourceService } from "../resources/resource-service.js";
import type { HeldPermit } from "../runs/run-model.js";
import {
  configurePermitActivityLedger,
  runWithPermitActivity,
  type PermitActivityLedger,
} from "./permit-activity.js";
import type { PermitCleanup } from "./permit-cleanup.js";

const info = {
  activityId: "permit-task",
  workflowExecution: { workflowId: "workflow", runId: "run" },
};
const job: PermitExecutionIdentity = {
  kind: "ocr",
  executionId: "job-1",
  endpoint: "https://ocr.test",
};

function fixture() {
  const cleanup: PermitCleanup = { state: "armed", attempts: 0, failure: null, executions: [] };
  const permit: HeldPermit = {
    permitId: info.activityId,
    ...info.workflowExecution,
    grantedAt: new Date().toISOString(),
    resources: ["ocr"],
    cleanup,
  };
  const ledger: PermitActivityLedger = {
    begin: vi.fn(async () => {
      cleanup.state = "running";
      return true;
    }),
    record: vi.fn(async (_owner, identity) => {
      cleanup.executions.push({ identity, stoppedAt: null, proof: null });
    }),
    prove: vi.fn(async (_owner, identity, proof) => {
      const record = cleanup.executions.find(
        (item) => item.identity.executionId === identity.executionId,
      );
      if (!record) {
        throw new Error("test identity missing");
      }
      record.proof = proof;
      record.stoppedAt = new Date().toISOString();
    }),
    finish: vi.fn(async (_owner, failure) => {
      cleanup.failure = failure;
      cleanup.state = cleanup.executions.some((item) => item.stoppedAt === null)
        ? "CLEANUP_UNVERIFIED"
        : "stopped";
    }),
  };
  configurePermitActivityLedger(ledger);
  const release = vi.fn(async () => true);
  const service = new ResourceService({
    resources: {
      held: async () => [permit],
      findHeld: async () => permit,
      list: async () => [],
      release,
    },
    workflows: {
      stopEvidence: async () => ({
        workflowId: "workflow",
        status: "FAILED",
        pendingActivities: 0,
        closedAt: new Date(0),
      }),
    },
    log: createLogger({ name: "test", level: "fatal" }),
  });
  return { cleanup, ledger, service, release };
}

describe("permit execution lifecycle", () => {
  it("unknown OCR work remains held and actionable through the resources API", async () => {
    const { cleanup, service, release } = fixture();
    const failure = new Error("OCR outcome unknown");
    await expect(
      runWithPermitActivity(info, async () => {
        await recordPermitExecution(job);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(cleanup.failure?.message).toContain("OCR outcome unknown");
    expect((await service.heldPermits())[0]?.cleanup).toMatchObject({
      state: "CLEANUP_UNVERIFIED",
      executions: [{ identity: job, stoppedAt: null }],
    });
    await expect(service.release(info.activityId)).rejects.toMatchObject({
      code: "PERMIT.STOP_NOT_PROVEN",
    });
    expect(await service.releaseStopped()).toEqual({ released: [], kept: 1 });
    expect(release).not.toHaveBeenCalled();
  });

  it("a failed business call releases only after exact job stop proof", async () => {
    const { cleanup, service, ledger, release } = fixture();
    await expect(
      runWithPermitActivity(info, async () => {
        expect(currentPermitExecution()?.permitId).toBe(info.activityId);
        await recordPermitExecution(job);
        await provePermitExecutionStopped(job, { kind: "ocr-job-stopped" });
        throw new Error("original failure");
      }),
    ).rejects.toThrow("original failure");
    expect(cleanup.state).toBe("stopped");
    await expect(service.release(info.activityId)).resolves.toMatchObject({ released: true });
    expect(release).toHaveBeenCalledOnce();
    expect(ledger.prove).toHaveBeenCalledWith(
      { permitId: info.activityId, ...info.workflowExecution },
      job,
      { kind: "ocr-job-stopped" },
    );
    expect(currentPermitExecution()).toBeUndefined();
  });

  it("a successful review cannot hide an unproved browser target", async () => {
    const { cleanup } = fixture();
    await runWithPermitActivity(info, async () => {
      await recordPermitExecution({ kind: "browser", executionId: "owned-page", taskSpaceId: 3 });
      return { status: "review" };
    });
    expect(cleanup.state).toBe("CLEANUP_UNVERIFIED");
  });

  it("a journal failure prevents executing work", async () => {
    const { ledger } = fixture();
    vi.mocked(ledger.begin).mockRejectedValue(new Error("journal unavailable"));
    const work = vi.fn();
    await expect(runWithPermitActivity(info, work)).rejects.toThrow("journal unavailable");
    expect(work).not.toHaveBeenCalled();
  });
});
