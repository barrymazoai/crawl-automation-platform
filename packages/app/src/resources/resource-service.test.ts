import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { HeldPermit } from "../runs/run-model.js";
import type { StopEvidence } from "../stops/stop-policy.js";
import { ResourceService, type ResourceStore } from "./resource-service.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});
const now = new Date("2026-09-29T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const permit = (permitId: string, workflowId: string): HeldPermit => ({
  permitId,
  workflowId,
  runId: `${workflowId}-run`,
  resources: ["scraperapi-lane"],
  grantedAt: "2026-09-29T11:00:00.000Z",
});

function setup(held: HeldPermit[], evidence: Record<string, StopEvidence | null>) {
  const resources: ResourceStore = {
    list: vi.fn(async () => []),
    held: vi.fn(async () => held),
    findHeld: vi.fn(async (id: string) => held.find((entry) => entry.permitId === id) ?? null),
    release: vi.fn(async () => true),
  };
  const workflows = {
    stopEvidence: vi.fn(async (workflowId: string) => evidence[workflowId] ?? null),
  };
  const service = new ResourceService({ resources, workflows, log: silent, now: () => now });
  return { service, resources, workflows };
}

const stopped = (
  workflowId: string,
  pendingActivities = 0,
  closedMinutesAgo = 10,
): StopEvidence => ({
  workflowId,
  status: "CANCELLED",
  closedAt: minutesAgo(closedMinutesAgo),
  pendingActivities,
});

describe("ResourceService.release", () => {
  it("releases a permit whose owner provably stopped", async () => {
    const { service, resources } = setup([permit("p1", "w1")], { w1: stopped("w1") });

    await expect(service.release("p1")).resolves.toEqual({ permitId: "p1", released: true });
    expect(resources.release).toHaveBeenCalledWith("p1");
  });

  it("refuses while the owner runs", async () => {
    const running = { ...stopped("w1"), status: "RUNNING", closedAt: null };
    const { service, resources } = setup([permit("p1", "w1")], { w1: running });

    await expect(service.release("p1")).rejects.toMatchObject({ code: "PERMIT.OWNER_RUNNING" });
    expect(resources.release).not.toHaveBeenCalled();
  });

  it("refuses while an Activity of the owner is pending", async () => {
    const { service } = setup([permit("p1", "w1")], { w1: stopped("w1", 1) });

    await expect(service.release("p1")).rejects.toMatchObject({ code: "PERMIT.STOP_NOT_PROVEN" });
  });

  it("refuses when Temporal cannot find the owner", async () => {
    const { service } = setup([permit("p1", "w1")], {});

    await expect(service.release("p1")).rejects.toMatchObject({ code: "PERMIT.STOP_NOT_PROVEN" });
  });

  it("reports an unknown permit", async () => {
    const { service } = setup([], {});

    await expect(service.release("p9")).rejects.toMatchObject({ code: "PERMIT.NOT_FOUND" });
  });
});

describe("ResourceService.releaseStopped", () => {
  it("releases only permits whose owners provably stopped, asking once per owner", async () => {
    const held = [permit("p1", "w1"), permit("p2", "w1"), permit("p3", "w2"), permit("p4", "w3")];
    const { service, workflows } = setup(held, {
      w1: stopped("w1"),
      w2: stopped("w2", 0, 2),
      w3: { ...stopped("w3"), status: "RUNNING", closedAt: null },
    });

    await expect(service.releaseStopped()).resolves.toEqual({ released: ["p1", "p2"], kept: 2 });
    expect(workflows.stopEvidence).toHaveBeenCalledTimes(3);
  });
});
