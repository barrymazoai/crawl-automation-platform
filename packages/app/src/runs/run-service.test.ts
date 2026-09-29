import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { StopEvidence } from "../stops/stop-policy.js";
import type { PermitStore, RunStore, WorkflowTree } from "./ports.js";
import type { HeldPermit, RunSummary, WorkflowMember } from "./run-model.js";
import { RunService } from "./run-service.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});
const now = new Date("2026-09-29T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const runId = "11111111-1111-4111-8111-111111111111";

const summary: RunSummary = {
  kind: "brand",
  runId,
  workflowId: `v3-collection-${runId}`,
  channel: "swanson",
  brandId: "22222222-2222-4222-8222-222222222222",
  brandName: "Healthy Origins",
  sourceId: "33333333-3333-4333-8333-333333333333",
  url: null,
  createdAt: "2026-09-29T11:00:00.000Z",
  guardHeld: true,
  delivery: {
    state: "CONFIRMED",
    observedStatus: "CANCELLED",
    lastIssue: "UNCONFIRMED_TERMINAL",
    closedAt: null,
  },
};

function member(workflowId: string, status: string): WorkflowMember {
  const closedAt = status === "RUNNING" ? null : minutesAgo(10);
  return { workflowId, type: "SwansonCatalogProductWorkflow", status, closedAt };
}

const permit: HeldPermit = {
  permitId: "permit-1",
  workflowId: "product-1",
  runId: "product-1-run",
  resources: ["mini-ego-space-1"],
  grantedAt: "2026-09-29T11:30:00.000Z",
};

interface Setup {
  members: WorkflowMember[];
  held?: HeldPermit[];
  evidence?: StopEvidence | null;
}

function setup({ members, held = [], evidence = null }: Setup) {
  const runs: RunStore = {
    accept: vi.fn(async () => summary),
    list: vi.fn(async () => [summary]),
    find: vi.fn(async (id: string) => (id === runId ? summary : null)),
    catalogProgress: vi.fn(async () => ({
      catalogPages: 1,
      discovered: 65,
      closure: null,
      closureFailure: null,
    })),
    settle: vi.fn(async (_id: string, permitIds: string[]) => ({
      permitsReleased: permitIds.length,
      guardReleased: true,
    })),
  };
  const tree: WorkflowTree = {
    members: vi.fn(async () => members),
    cancel: vi.fn(async () => undefined),
    stopEvidence: vi.fn(async () => evidence),
  };
  const permits: PermitStore = { heldBy: vi.fn(async () => held) };
  const productRuns = { submit: vi.fn(async () => runId) };
  const service = new RunService({ runs, tree, permits, productRuns, log: silent, now: () => now });
  return { service, runs, tree, productRuns };
}

const stoppedEvidence: StopEvidence = {
  workflowId: "product-1",
  status: "CANCELLED",
  closedAt: minutesAgo(10),
  pendingActivities: 0,
};

describe("RunService", () => {
  it("reports progress, workflow counts and held permits", async () => {
    const { service } = setup({
      members: [member("p1", "RUNNING"), member("p2", "COMPLETED")],
      held: [permit],
    });

    const detail = await service.get(runId);

    expect(detail.progress.discovered).toBe(65);
    expect(detail.workflows).toEqual({
      SwansonCatalogProductWorkflow: { RUNNING: 1, COMPLETED: 1 },
    });
    expect(detail.heldPermits).toEqual([permit]);
  });

  it("cancels only the running workflows of the run", async () => {
    const { service, tree } = setup({
      members: [member("p1", "RUNNING"), member("v1", "RUNNING"), member("p2", "COMPLETED")],
    });

    await expect(service.cancel(runId)).resolves.toEqual({ runId, cancelled: 2 });
    expect(vi.mocked(tree.cancel).mock.calls.map(([id]) => id)).toEqual(["p1", "v1"]);
  });

  it("reports an unknown run", async () => {
    const { service } = setup({ members: [] });

    await expect(service.get("99999999-9999-4999-8999-999999999999")).rejects.toMatchObject({
      code: "RUN.NOT_FOUND",
    });
  });
});

describe("RunService.settle", () => {
  it("releases the permits and guard of a provably stopped run", async () => {
    const { service, runs } = setup({
      members: [member("product-1", "CANCELLED")],
      held: [permit],
      evidence: stoppedEvidence,
    });

    await expect(service.settle(runId)).resolves.toEqual({
      runId,
      permitsReleased: 1,
      guardReleased: true,
    });
    expect(runs.settle).toHaveBeenCalledWith(runId, ["permit-1"]);
  });

  it("refuses while a workflow runs", async () => {
    const { service, runs } = setup({ members: [member("product-1", "RUNNING")] });

    await expect(service.settle(runId)).rejects.toMatchObject({ code: "RUN.STILL_RUNNING" });
    expect(runs.settle).not.toHaveBeenCalled();
  });

  it("refuses while a permit's owner has a pending Activity", async () => {
    const pending = { ...stoppedEvidence, pendingActivities: 1 };
    const { service } = setup({
      members: [member("product-1", "CANCELLED")],
      held: [permit],
      evidence: pending,
    });

    await expect(service.settle(runId)).rejects.toMatchObject({ code: "RUN.STOP_NOT_PROVEN" });
  });
});

describe("RunService.settleStopped", () => {
  it("settles an ended run that runs nothing and holds nothing", async () => {
    const { service, runs } = setup({ members: [member("root", "CANCELLED")] });

    await expect(service.settleStopped()).resolves.toEqual([
      { runId, permitsReleased: 0, guardReleased: true },
    ]);
    expect(runs.settle).toHaveBeenCalledWith(runId, []);
  });

  it("leaves a run that still holds a permit for the permit sweep", async () => {
    const { service, runs } = setup({ members: [member("root", "CANCELLED")], held: [permit] });

    await expect(service.settleStopped()).resolves.toEqual([]);
    expect(runs.settle).not.toHaveBeenCalled();
  });

  it("leaves a run with a running workflow", async () => {
    const { service } = setup({ members: [member("root", "CANCELLED"), member("p1", "RUNNING")] });

    await expect(service.settleStopped()).resolves.toEqual([]);
  });
});
