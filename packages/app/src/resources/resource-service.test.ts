import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { HeldPermit, WorkflowMember } from "../runs/run-model.js";
import { ResourceService, type ResourceStore } from "./resource-service.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});
const now = new Date("2026-09-29T12:00:00.000Z");
const permit: HeldPermit = {
  permitId: "permit-1",
  workflowId: "product-1",
  resources: ["scraperapi-lane"],
  grantedAt: "2026-09-29T11:00:00.000Z",
};

function setup(owner: WorkflowMember | null) {
  const resources: ResourceStore = {
    list: vi.fn(async () => []),
    held: vi.fn(async () => [permit]),
    findHeld: vi.fn(async (id: string) => (id === permit.permitId ? permit : null)),
    release: vi.fn(async () => true),
  };
  const service = new ResourceService({
    resources,
    workflows: { status: async () => owner },
    log: silent,
    now: () => now,
  });
  return { service, resources };
}

const stopped = (minutesAgo: number): WorkflowMember => ({
  workflowId: "product-1",
  type: "AmazonCatalogProductWorkflow",
  status: "CANCELLED",
  closedAt: new Date(now.getTime() - minutesAgo * 60_000),
});

describe("ResourceService.release", () => {
  it("releases a permit whose owner stopped over two minutes ago", async () => {
    const { service, resources } = setup(stopped(5));

    await expect(service.release("permit-1")).resolves.toEqual({
      permitId: "permit-1",
      released: true,
    });
    expect(resources.release).toHaveBeenCalledWith("permit-1");
  });

  it("refuses while the owner runs", async () => {
    const { service, resources } = setup({ ...stopped(0), status: "RUNNING", closedAt: null });

    await expect(service.release("permit-1")).rejects.toMatchObject({
      code: "PERMIT.OWNER_RUNNING",
    });
    expect(resources.release).not.toHaveBeenCalled();
  });

  it("refuses within two minutes of the owner's stop", async () => {
    const { service } = setup(stopped(1));

    await expect(service.release("permit-1")).rejects.toMatchObject({
      code: "PERMIT.OWNER_RECENTLY_STOPPED",
    });
  });

  it("reports an unknown permit", async () => {
    const { service } = setup(stopped(5));

    await expect(service.release("permit-9")).rejects.toMatchObject({ code: "PERMIT.NOT_FOUND" });
  });
});
