import {
  createLogger,
  egoErrors,
  provePermitExecutionStopped,
  type PermitExecutionIdentity,
} from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { BrowserRecovery, type BrowserRecoveryEntry } from "./browser-recovery.js";
import { ResourceService } from "./resource-service.js";

function fixture() {
  const owner = { permitId: "permit-one", workflowId: "workflow", runId: "run" };
  const round: PermitExecutionIdentity = {
    kind: "browser-round",
    executionId: "round",
    taskSpaceId: 6,
    metadata: { host: "host", protocol: "ego-single-page/1", baseline: [] },
  };
  const page: PermitExecutionIdentity = {
    kind: "browser",
    executionId: "page",
    taskSpaceId: 6,
    metadata: { host: "host", roundId: "round" },
  };
  const cli: PermitExecutionIdentity = { ...round, kind: "browser-cli", executionId: "round/cli" };
  const entry: BrowserRecoveryEntry = {
    owner,
    executions: [
      { identity: round, stopped: false },
      { identity: page, stopped: false },
      { identity: cli, stopped: true },
    ],
  };
  let state: "stopped" | "CLEANUP_UNVERIFIED" = "CLEANUP_UNVERIFIED";
  const originalFailure = { code: "BROWSER.PAGE_CLEANUP_PENDING" };
  const ledger = {
    pendingBrowser: vi.fn(async () => [entry]),
    begin: vi.fn(),
    record: vi.fn(),
    prove: vi.fn(async (_owner, identity: PermitExecutionIdentity) => {
      const found = entry.executions.find(
        (item) => item.identity.executionId === identity.executionId,
      );
      if (found) {
        found.stopped = true;
      }
    }),
    finish: vi.fn(async () => {
      state = entry.executions.every((item) => item.stopped) ? "stopped" : "CLEANUP_UNVERIFIED";
    }),
  };
  const release = vi.fn(async () => true);
  const resources = new ResourceService({
    resources: {
      list: vi.fn(),
      held: vi.fn(),
      release,
      findHeld: async () => ({
        ...owner,
        grantedAt: new Date(0).toISOString(),
        resources: ["browser"],
        cleanup: { state, failure: originalFailure, attempts: 1, executions: [] },
      }),
    },
    workflows: {
      stopEvidence: async () => ({
        workflowId: owner.workflowId,
        status: "FAILED",
        closedAt: new Date(0),
        pendingActivities: 0,
      }),
    },
    log: createLogger({ name: "test", level: "fatal" }),
  });
  const stop = vi.fn(async () => {
    await provePermitExecutionStopped(page, { kind: "browser-target-absent" });
    await provePermitExecutionStopped(round, { kind: "browser-round-ended" });
  });
  const recovery = new BrowserRecovery({
    ledger,
    stop,
    release: (permitId) => resources.release(permitId),
    log: createLogger({ name: "test", level: "fatal" }),
  });
  return { ledger, recovery, release, stop, entry, resources, originalFailure };
}

describe("browser R59 recovery", () => {
  it("keeps an infrastructure failure pending, then releases only after durable proofs and a terminal owner", async () => {
    const test = fixture();
    test.stop.mockRejectedValueOnce(egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING"));
    await test.recovery.tick("host", 6);
    expect(test.release).not.toHaveBeenCalled();
    expect(test.ledger.finish).not.toHaveBeenCalled();
    await test.recovery.tick("host", 6);
    expect(test.ledger.prove).toHaveBeenCalledTimes(2);
    expect(test.ledger.finish).toHaveBeenCalledWith(test.entry.owner, null);
    expect(test.release).toHaveBeenCalledExactlyOnceWith("permit-one");
    expect(test.originalFailure).toEqual({ code: "BROWSER.PAGE_CLEANUP_PENDING" });
  });

  it("never closes targets or releases capacity without a CLI exit receipt", async () => {
    const test = fixture();
    for (const item of test.entry.executions) {
      item.stopped = false;
    }
    await test.recovery.tick("host", 6);
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.release).not.toHaveBeenCalled();
  });

  it("respects user control and keeps the original attempt pending without business replay", async () => {
    const test = fixture();
    test.stop.mockRejectedValue(egoErrors.create("BROWSER.USER_CONTROL"));
    await test.recovery.tick("host", 6);
    expect(test.release).not.toHaveBeenCalled();
    expect(test.ledger.begin).not.toHaveBeenCalled();
    expect(test.ledger.record).not.toHaveBeenCalled();
  });
});
