import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { PermitStore, RunStore, WorkflowTree } from "./ports.js";
import type { HeldPermit, RunSummary, WorkflowMember } from "./run-model.js";
import { RunService } from "./run-service.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});
const now = new Date("2026-09-29T12:00:00.000Z");
const runId = "11111111-1111-4111-8111-111111111111";
const root = `v3-collection-${runId}`;

const summary: RunSummary = {
  runId,
  workflowId: root,
  channel: "swanson",
  brandId: "22222222-2222-4222-8222-222222222222",
  brandName: "Healthy Origins",
  sourceId: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-09-29T11:00:00.000Z",
  guardHeld: true,
  delivery: null,
};

function member(workflowId: string, status: string, closedMinutesAgo?: number): WorkflowMember {
  const closedAt =
    closedMinutesAgo === undefined ? null : new Date(now.getTime() - closedMinutesAgo * 60_000);
  return { workflowId, type: "SwansonCatalogProductWorkflow", status, closedAt };
}

function setup(members: WorkflowMember[], held: HeldPermit[] = []) {
  const runs: RunStore = {
    accept: vi.fn(async () => summary),
    list: vi.fn(async () => [summary]),
    find: vi.fn(async (id: string) => (id === runId ? summary : null)),
    catalogProgress: vi.fn(async () => ({ catalogPages: 1, discovered: 65, closure: null })),
    settle: vi.fn(async (_id: string, permitIds: string[]) => ({
      permitsReleased: permitIds.length,
      guardReleased: true,
    })),
  };
  const tree: WorkflowTree = {
    members: vi.fn(async () => members),
    cancel: vi.fn(async () => undefined),
  };
  const permits: PermitStore = { heldBy: vi.fn(async () => held) };
  const service = new RunService({ runs, tree, permits, log: silent, now: () => now });
  return { service, runs, tree, permits };
}

const permit: HeldPermit = {
  permitId: "permit-1",
  workflowId: "product-1",
  resources: ["mini-ego-space-1"],
  grantedAt: "2026-09-29T11:30:00.000Z",
};

describe("RunService", () => {
  it("reports progress, workflow counts and held permits", async () => {
    const { service } = setup(
      [member("product-1", "RUNNING"), member("product-2", "COMPLETED", 5)],
      [permit],
    );

    const detail = await service.get(runId);

    expect(detail.progress.discovered).toBe(65);
    expect(detail.workflows).toEqual({
      SwansonCatalogProductWorkflow: { RUNNING: 1, COMPLETED: 1 },
    });
    expect(detail.heldPermits).toEqual([permit]);
  });

  it("cancels only the running workflows of the run", async () => {
    const { service, tree } = setup([
      member("product-1", "RUNNING"),
      member("variant-1", "RUNNING"),
      member("product-2", "COMPLETED", 5),
    ]);

    await expect(service.cancel(runId)).resolves.toEqual({ runId, cancelled: 2 });
    expect(vi.mocked(tree.cancel).mock.calls.map(([id]) => id)).toEqual(["product-1", "variant-1"]);
  });

  it("settles a stopped run by releasing its permits and guard", async () => {
    const { service, runs } = setup([member("product-1", "CANCELLED", 3)], [permit]);

    await expect(service.settle(runId)).resolves.toEqual({
      runId,
      permitsReleased: 1,
      guardReleased: true,
    });
    expect(runs.settle).toHaveBeenCalledWith(runId, ["permit-1"]);
  });

  it("refuses to settle while a workflow runs", async () => {
    const { service, runs } = setup([member("product-1", "RUNNING")]);

    await expect(service.settle(runId)).rejects.toMatchObject({ code: "RUN.STILL_RUNNING" });
    expect(runs.settle).not.toHaveBeenCalled();
  });

  it("refuses to settle within two minutes of a stop", async () => {
    const { service } = setup([member("product-1", "CANCELLED", 1)]);

    await expect(service.settle(runId)).rejects.toMatchObject({ code: "RUN.RECENTLY_STOPPED" });
  });

  it("reports an unknown run", async () => {
    const { service } = setup([]);

    await expect(service.get("99999999-9999-4999-8999-999999999999")).rejects.toMatchObject({
      code: "RUN.NOT_FOUND",
    });
  });
});
