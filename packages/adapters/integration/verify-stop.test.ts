import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type PermitExecutionIdentity } from "@crawl-automation/platform";
import { ResourceService, StopVerification } from "@crawl-automation/app";
import { OcrApiSettingsSchema, OcrHttpJobControl } from "@crawl-automation/processing";
import { PostgresResourceAdmission } from "../src/postgres/postgres-resource-admission.js";
import { PostgresResourceStore } from "../src/postgres/postgres-resource-store.js";
import { PostgresPermitExecutions } from "../src/postgres/postgres-permit-executions.js";
import { PostgresStopVerification } from "../src/postgres/postgres-stop-verification.js";
import { ExecutorStopVerifier } from "../src/permit-stop-verifier.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

let postgres: TemporaryPostgres;
const ocr = OcrApiSettingsSchema.parse({
  baseUrl: "https://ocr.test",
  provider: "ocr/1",
  jobControl: true,
});
const log = createLogger({ name: "verify-stop-postgres", level: "fatal" });

beforeAll(async () => {
  postgres = await startTemporaryPostgres();
}, 120_000);
afterAll(async () => {
  await postgres?.stop();
});
beforeEach(async () => {
  await postgres.database.query(`TRUNCATE resource_permit_execution, resource_permit_stop,
    resource_permit_event, resource_permit_need, resource_permit`);
  await postgres.database
    .query(`INSERT INTO resource_capacity(resource_id, capacity, healthy, health_until)
    VALUES ('stop-test-ocr', 6, true, now() + interval '1 hour') ON CONFLICT DO NOTHING`);
});

async function seed(
  suffix: string,
  state: "running" | "CLEANUP_UNVERIFIED" = "CLEANUP_UNVERIFIED",
) {
  const owner = {
    permitId: `permit-${suffix}`,
    workflowId: `workflow-${suffix}`,
    runId: randomUUID(),
  };
  const ledger = new PostgresPermitExecutions(postgres.database);
  await new PostgresResourceAdmission(postgres.database).reserve({
    ...owner,
    needs: [{ resourceId: "stop-test-ocr", units: 1 }],
  });
  await ledger.begin(owner);
  const identity: PermitExecutionIdentity = {
    kind: "ocr",
    executionId: `job-${suffix}`,
    endpoint: ocr.baseUrl,
    metadata: { jobControlSupported: true },
  };
  await ledger.record(owner, identity);
  if (state !== "running") {
    await ledger.finish(owner, { code: "OCR.TIMEOUT" });
  }
  return { owner, identity, ledger };
}

function service(state = "failed") {
  const resources = new PostgresResourceStore(postgres.database);
  const journal = new PostgresStopVerification(postgres.database);
  const workflows = {
    stopEvidence: vi.fn(async (_workflowId: string, _runId: string) => ({
      workflowId: _workflowId,
      status: "COMPLETED",
      closedAt: new Date(0),
      pendingActivities: 0,
    })),
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
  const verifier = new ExecutorStopVerifier({
    resources,
    ledger: new PostgresPermitExecutions(postgres.database),
    browser: { verify: vi.fn() },
    ocr,
    control: new OcrHttpJobControl({ baseUrl: ocr.baseUrl, fetch }),
  });
  const stopVerification = new StopVerification({ resources, workflows, journal, verifier, log });
  return {
    resources,
    journal,
    workflows,
    fetch,
    resourcesService: new ResourceService({ resources, workflows, log, stopVerification }),
  };
}

describe("resources.verifyStop against PostgreSQL R59 journal and release trigger", () => {
  it("failed OCR proves, finishes and releases; preserves original failure and immutable proof", async () => {
    const { owner, identity } = await seed("failed");
    const test = service();
    expect(await test.resourcesService.verifyStop(owner.permitId)).toMatchObject({
      released: true,
      executions: [{ executionId: identity.executionId, stopped: true }],
    });
    expect(await test.resources.findHeld(owner.permitId)).toBeNull();
    const [saved] = await postgres.database.query<{
      state: string;
      failure: unknown;
      attempts: number;
    }>(
      `SELECT state, failure, cleanup_attempts AS attempts FROM resource_permit_stop WHERE permit_id = $1`,
      [owner.permitId],
    );
    expect(saved).toMatchObject({
      state: "stopped",
      failure: { code: "OCR.TIMEOUT" },
      attempts: 1,
    });
    expect(test.workflows.stopEvidence).toHaveBeenCalledWith(owner.workflowId, owner.runId);
    expect(test.fetch).toHaveBeenCalledOnce();
  });

  it.each(["unknown", "unreachable"])(
    "%s stays held with a reason and the release guard intact",
    async (state) => {
      const { owner } = await seed(state);
      const test = service("unknown");
      if (state === "unreachable") {
        test.fetch.mockRejectedValue(new TypeError("fetch failed"));
      }
      expect(await test.resourcesService.verifyStop(owner.permitId)).toMatchObject({
        released: false,
        executions: [
          { stopped: false, reason: state === "unknown" ? "job_unknown" : "job_control_failed" },
        ],
      });
      await expect(test.resources.release(owner.permitId)).rejects.toThrow();
      expect((await test.resources.findHeld(owner.permitId))?.cleanup?.state).toBe(
        "CLEANUP_UNVERIFIED",
      );
    },
  );

  it("sweeps only unverified closed owners and leaves running owners and activities alone", async () => {
    const closed = await seed("a-closed");
    const running = await seed("b-running-owner");
    await seed("c-running-activity", "running");
    const test = service();
    test.workflows.stopEvidence.mockImplementation(async (workflowId) => ({
      workflowId,
      status: workflowId === running.owner.workflowId ? "RUNNING" : "COMPLETED",
      closedAt: new Date(0),
      pendingActivities: 0,
    }));
    expect((await test.resourcesService.verifyStops()).released).toEqual([closed.owner.permitId]);
    expect(test.fetch).toHaveBeenCalledOnce();
    expect(await test.resources.findHeld(running.owner.permitId)).not.toBeNull();
    expect(await test.journal.candidates(1, "")).toEqual([running.owner.permitId]);
    expect(await test.journal.candidates(1, running.owner.permitId)).toEqual([]);
  });

  it("does not release a second unproved execution and refuses proof for another owner", async () => {
    const { owner, ledger, identity } = await seed("two", "running");
    await ledger.record(owner, {
      ...identity,
      executionId: "second",
      endpoint: "https://other.test",
    });
    await ledger.finish(owner, { code: "OCR.TIMEOUT" });
    const test = service();
    expect(await test.resourcesService.verifyStop(owner.permitId)).toMatchObject({
      released: false,
    });
    await expect(
      ledger.prove({ ...owner, runId: randomUUID() }, identity, { kind: "fake" }),
    ).rejects.toMatchObject({ code: "RESOURCE.IDENTITY_CONFLICT" });
    await expect(test.resources.release(owner.permitId)).rejects.toThrow();
  });

  it("serializes concurrent recoveries without holding a permit row lock", async () => {
    const journal = new PostgresStopVerification(postgres.database);
    let unlock: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let entered: () => void = () => undefined;
    const enteredLock = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = journal.exclusive(async () => {
      entered();
      await waiting;
      return true;
    });
    await enteredLock;
    try {
      expect(await journal.exclusive(async () => false)).toBeNull();
    } finally {
      unlock();
    }
    expect(await first).toBe(true);
  });
});
