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
  it("keeps the native capture page until the Codex process group has a stop receipt", async () => {
    const test = fixture();
    const round = test.entry.executions[0];
    if (!round) {
      throw new Error("missing round");
    }
    round.identity.metadata = { ...round.identity.metadata, protocol: "ego-native-capture/1" };
    const codex = {
      identity: {
        kind: "codex" as const,
        executionId: "agent",
        pid: 100,
        host: "host",
        startedAt: new Date().toISOString(),
      },
      stopped: false,
    };
    test.entry.executions.push(codex);
    await test.recovery.tick("host", 6);
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.release).not.toHaveBeenCalled();
    codex.stopped = true;
    await test.recovery.tick("host", 6);
    expect(test.stop).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledOnce();
  });
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

  it("accepts host proof for a CLI whose exit receipt was lost, and waits while one may still run", async () => {
    const test = fixture();
    const cli = test.entry.executions[2];
    if (!cli) {
      throw new Error("missing cli");
    }
    cli.stopped = false;
    cli.recordedAt = "2026-10-07T03:29:43.655Z";
    const cliAbsent = vi.fn(async () => null as Record<string, unknown> | null);
    const recovery = new BrowserRecovery({
      ledger: test.ledger,
      stop: test.stop,
      release: (permitId) => test.resources.release(permitId),
      cliAbsent,
      log: createLogger({ name: "test", level: "fatal" }),
    });
    await recovery.tick("host", 6);
    expect(cliAbsent).toHaveBeenCalledWith(new Date("2026-10-07T03:29:43.655Z"));
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.release).not.toHaveBeenCalled();
    cliAbsent.mockResolvedValueOnce({ kind: "browser-cli-absent" });
    await recovery.tick("host", 6);
    expect(test.ledger.prove).toHaveBeenCalledWith(test.entry.owner, cli.identity, {
      kind: "browser-cli-absent",
    });
    expect(test.stop).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledExactlyOnceWith("permit-one");
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
