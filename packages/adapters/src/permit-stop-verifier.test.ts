import { describe, expect, it, vi } from "vitest";
import { createLogger, type PermitExecutionIdentity } from "@crawl-automation/platform";
import { ResourceService, StopVerification, type HeldPermit } from "@crawl-automation/app";
import { OcrApiSettingsSchema, OcrHttpJobControl } from "@crawl-automation/processing";
import { ExecutorStopVerifier } from "./permit-stop-verifier.js";

const ocr = OcrApiSettingsSchema.parse({
  baseUrl: "https://ocr.test",
  provider: "ocr/1",
  jobControl: true,
});
const job: PermitExecutionIdentity = {
  kind: "ocr",
  executionId: "exact-job",
  endpoint: ocr.baseUrl,
  metadata: { jobControlSupported: true },
};

export function fixture(state: string) {
  const permit: HeldPermit = {
    permitId: "permit-one",
    workflowId: "workflow",
    runId: "run",
    resources: ["ocr"],
    grantedAt: new Date(0).toISOString(),
    cleanup: {
      state: "CLEANUP_UNVERIFIED",
      attempts: 46,
      failure: { code: "OCR.TIMEOUT" },
      executions: [{ identity: job, stoppedAt: null, proof: null }],
    },
  };
  const resources = {
    findHeld: vi.fn(async () => permit),
    held: async () => [permit],
    list: async () => [],
    release: vi.fn(async () => true),
  };
  const ledger = {
    record: vi.fn(),
    prove: vi.fn(async (_owner, identity, proof) => {
      const entry = permit.cleanup?.executions.find(
        (entry) => entry.identity.executionId === identity.executionId,
      );
      if (entry) {
        entry.stoppedAt = new Date().toISOString();
        entry.proof = proof;
      }
    }),
  };
  const fetch = vi.fn(async (_request: Request) =>
    Response.json({
      state,
      worker_pid: 42,
      started_at: "2026-10-01T00:00:00Z",
      finished_at: state === "unknown" ? null : "2026-10-01T00:01:30Z",
      cancel_requested: false,
    }),
  );
  const browser = { verify: vi.fn(async () => undefined) };
  const verifier = new ExecutorStopVerifier({
    ledger,
    resources,
    browser,
    ocr,
    control: new OcrHttpJobControl({ baseUrl: ocr.baseUrl, fetch }),
  });
  const workflows = {
    stopEvidence: async () => ({
      workflowId: permit.workflowId,
      status: "COMPLETED",
      closedAt: new Date(0),
      pendingActivities: 0,
    }),
  };
  const journal = {
    candidates: async () => [permit.permitId],
    exclusive: async <T>(work: () => Promise<T>) => work(),
    attempted: vi.fn(),
    finish: async () => {
      if (permit.cleanup) {
        permit.cleanup.state = "stopped";
      }
    },
  };
  const log = createLogger({ name: "test", level: "fatal" });
  const stopVerification = new StopVerification({ resources, workflows, journal, verifier, log });
  return {
    permit,
    ledger,
    fetch,
    browser,
    resources,
    verifier,
    service: new ResourceService({ resources, workflows, log, stopVerification }),
  };
}

describe("executor verification using R59 OCR receipts", () => {
  it.each(["done", "failed", "cancelled"])(
    "%s job proves and releases through ResourceService",
    async (state) => {
      const test = fixture(state);
      expect(await test.service.verifyStop(test.permit.permitId)).toMatchObject({
        released: true,
        executions: [{ executionId: "exact-job", stopped: true }],
      });
      expect(test.fetch).toHaveBeenCalledOnce();
      expect(test.fetch.mock.calls[0]?.[0]).toMatchObject({
        method: "GET",
        url: "https://ocr.test/jobs/exact-job",
      });
      expect(test.ledger.prove).toHaveBeenCalledWith(
        test.permit,
        job,
        expect.objectContaining({ kind: "ocr-job-stopped" }),
      );
      expect(test.resources.release).toHaveBeenCalledOnce();
    },
  );

  it("unknown stays held and is not cancelled or resubmitted", async () => {
    const test = fixture("unknown");
    expect(await test.service.verifyStop(test.permit.permitId)).toMatchObject({
      released: false,
      executions: [{ stopped: false, reason: "job_unknown" }],
    });
    expect(test.fetch).toHaveBeenCalledOnce();
    expect(test.resources.release).not.toHaveBeenCalled();
  });

  it("unreachable retains the real nested network cause", async () => {
    const test = fixture("failed");
    test.fetch.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      }),
    );
    expect(await test.service.verifyStop(test.permit.permitId)).toMatchObject({
      released: false,
      executions: [
        {
          stopped: false,
          reason: "job_control_failed",
          cause: expect.stringContaining("ECONNREFUSED"),
        },
      ],
    });
    expect(test.fetch).toHaveBeenCalledOnce();
    expect(test.resources.release).not.toHaveBeenCalled();
  });

  it("refuses a different endpoint and unsupported job-control identities", async () => {
    const test = fixture("failed");
    const execution = test.permit.cleanup?.executions[0];
    if (execution) {
      execution.identity = { ...job, endpoint: "https://other.test" };
    }
    expect(await test.service.verifyStop(test.permit.permitId)).toMatchObject({ released: false });
    expect(test.fetch).not.toHaveBeenCalled();
  });
});

describe("codex turns of a permit without a browser (KAN-243, 2026-11-12)", () => {
  // The label model worker on Server 一 held its permits after a stuck turn: the browser check refused them.
  const turn: PermitExecutionIdentity = {
    kind: "codex",
    executionId: "turn-1",
    pid: 15256,
    host: "servers-Mac-mini.local",
    startedAt: "2026-11-12T01:29:16.126Z",
  };
  function codexFixture(resources: string[], absent: Record<string, unknown> | null) {
    const test = fixture("done");
    test.permit.resources = resources;
    const execution = test.permit.cleanup?.executions[0];
    if (execution) {
      execution.identity = turn;
    }
    const codexAbsent = vi.fn(async () => absent);
    const verifier = new ExecutorStopVerifier({
      ledger: test.ledger,
      resources: test.resources,
      browser: test.browser,
      codexAbsent,
    });
    return { ...test, verifier, codexAbsent };
  }

  it("proves a gone process group on this host and lets the permit be released", async () => {
    const proof = { kind: "codex-process-group-absent", pid: 15256 };
    const test = codexFixture(["mini-cpu", "mini-model-account"], proof);
    expect(await test.verifier.verify(test.permit)).toEqual([
      { executionId: "turn-1", kind: "codex", stopped: true },
    ]);
    expect(test.ledger.prove).toHaveBeenCalledWith(test.permit, turn, proof);
    expect(test.browser.verify).not.toHaveBeenCalled();
  });

  it("keeps the permit while the process group may still run, without asking the browser", async () => {
    const test = codexFixture(["mini-cpu", "mini-model-account"], null);
    expect(await test.verifier.verify(test.permit)).toEqual([
      {
        executionId: "turn-1",
        kind: "codex",
        stopped: false,
        reason: "codex_process_present_or_other_host",
      },
    ]);
    expect(test.ledger.prove).not.toHaveBeenCalled();
    expect(test.browser.verify).not.toHaveBeenCalled();
  });

  it("still sends a codex turn of a browser permit to its browser host", async () => {
    const test = codexFixture(["server2-ego-space-15", "mini-model-account"], { kind: "x" });
    await test.verifier.verify(test.permit);
    expect(test.codexAbsent).not.toHaveBeenCalled();
    expect(test.browser.verify).toHaveBeenCalledOnce();
  });
});
