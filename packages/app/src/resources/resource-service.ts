import type { Logger } from "@crawl-automation/platform";
import { differenceInSeconds } from "date-fns";
import { appErrors } from "../errors.js";
import type { HeldPermit, WorkflowMember } from "../runs/run-model.js";

export interface ResourceState {
  resourceId: string;
  capacity: number;
  held: number;
  healthy: boolean;
  reason: string;
}

export interface ResourceStore {
  list(): Promise<ResourceState[]>;
  held(): Promise<HeldPermit[]>;
  findHeld(permitId: string): Promise<HeldPermit | null>;
  release(permitId: string): Promise<boolean>;
}

export interface WorkflowStatusReader {
  status(workflowId: string): Promise<WorkflowMember | null>;
}

const RELEASE_AFTER_SECONDS = 120;

/** Resource capacity, health and held permits; releases a permit only after its owner has stopped. */
export class ResourceService {
  constructor(
    private readonly deps: {
      resources: ResourceStore;
      workflows: WorkflowStatusReader;
      log: Logger;
      now?: () => Date;
    },
  ) {}

  list(): Promise<ResourceState[]> {
    return this.deps.resources.list();
  }

  heldPermits(): Promise<HeldPermit[]> {
    return this.deps.resources.held();
  }

  async release(permitId: string): Promise<{ permitId: string; released: boolean }> {
    const permit = await this.deps.resources.findHeld(permitId);
    if (!permit) {
      throw appErrors.create("PERMIT.NOT_FOUND", { details: { permitId } });
    }
    const owner = await this.deps.workflows.status(permit.workflowId);
    this.assertOwnerStopped(permit, owner);
    const released = await this.deps.resources.release(permitId);
    this.deps.log.info({ permitId, workflowId: permit.workflowId, released }, "permit released");
    return { permitId, released };
  }

  private assertOwnerStopped(permit: HeldPermit, owner: WorkflowMember | null): void {
    if (owner?.status === "RUNNING") {
      throw appErrors.create("PERMIT.OWNER_RUNNING", {
        details: { workflowId: permit.workflowId },
      });
    }
    const now = this.deps.now?.() ?? new Date();
    if (owner?.closedAt && differenceInSeconds(now, owner.closedAt) < RELEASE_AFTER_SECONDS) {
      throw appErrors.create("PERMIT.OWNER_RECENTLY_STOPPED", {
        details: { workflowId: permit.workflowId },
      });
    }
  }
}
