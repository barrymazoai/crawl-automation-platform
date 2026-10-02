import type { StopVerification } from "../stops/stop-verification.js";
import type { Logger } from "@crawl-automation/platform";
import { appErrors } from "../errors.js";
import type { HeldPermit } from "../runs/run-model.js";
import { judgePermits, type StopEvidenceReader } from "../stops/judge-permits.js";

import type { ResourceStore, ResourceState, ReleaseSweep } from "./resource-ports.js";
export type { ResourceStore, ResourceState, ReleaseSweep } from "./resource-ports.js";

/** Resource capacity, health and held permits. A permit is released only when its owner provably stopped. */
export class ResourceService {
  constructor(
    private readonly deps: {
      resources: ResourceStore;
      workflows: StopEvidenceReader;
      log: Logger;
      now?: () => Date;
      stopVerification?: StopVerification;
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
    const [judged] = await judgePermits([permit], this.deps.workflows, this.now());
    if (judged?.verdict === "running") {
      throw appErrors.create("PERMIT.OWNER_RUNNING", {
        details: { workflowId: permit.workflowId },
      });
    }
    if (judged?.verdict !== "stopped") {
      throw appErrors.create("PERMIT.STOP_NOT_PROVEN", {
        details: { workflowId: permit.workflowId },
      });
    }
    const released = await this.deps.resources.release(permitId);
    this.deps.log.info({ permitId, workflowId: permit.workflowId, released }, "permit released");
    return { permitId, released };
  }

  /** Releases every held permit whose owner provably stopped; the rest stay held. */
  async releaseStopped(): Promise<ReleaseSweep> {
    const judged = await judgePermits(
      await this.deps.resources.held(),
      this.deps.workflows,
      this.now(),
    );
    const released: string[] = [];
    for (const { permit, verdict } of judged) {
      if (verdict === "stopped" && (await this.deps.resources.release(permit.permitId))) {
        released.push(permit.permitId);
        this.deps.log.info(
          { permitId: permit.permitId, workflowId: permit.workflowId },
          "stopped owner's permit released",
        );
      }
    }
    return { released, kept: judged.length - released.length };
  }

  verifyStop(permitId: string) {
    return this.verification().verify(permitId, (id) => this.release(id));
  }

  verifyStops() {
    return this.verification().sweep((id) => this.release(id));
  }

  private verification(): StopVerification {
    if (!this.deps.stopVerification) {
      throw appErrors.create("PERMIT.VERIFICATION_NOT_CONFIGURED");
    }
    return this.deps.stopVerification;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
