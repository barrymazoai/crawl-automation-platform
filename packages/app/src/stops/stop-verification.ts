import { errorCodeOf, type Logger, type PermitOwner } from "@crawl-automation/platform";
import { appErrors } from "../errors.js";
import type { HeldPermit } from "../runs/run-model.js";
import type { ResourceStore } from "../resources/resource-ports.js";
import type { StopEvidenceReader } from "./judge-permits.js";
import { PURGED_OWNER_STATUS, purgedOwnerEvidence, stopVerdict } from "./stop-policy.js";

export interface ExecutionStopResult {
  executionId: string;
  kind: string;
  stopped: boolean;
  reason?: string;
  cause?: string;
}
export interface VerifyStopResult {
  permitId: string;
  released: boolean;
  executions: ExecutionStopResult[];
  reason?: string;
}
export interface StopVerificationStore {
  candidates(limit: number, after: string): Promise<string[]>;
  /** Cross-process exclusion; never waits for another verifier's provider calls. */
  exclusive<T>(work: () => Promise<T>): Promise<T | null>;
  attempted(owner: PermitOwner): Promise<void>;
  finish(owner: PermitOwner, failure: Record<string, unknown> | null): Promise<void>;
  /** Marks a permit that never began work as stopped; false when it began or recorded any execution. */
  settleUnstarted?(owner: PermitOwner): Promise<boolean>;
  /** Marks a permit of a purged owner as stopped; false while any recorded execution is not proven stopped. */
  settlePurged?(owner: PermitOwner): Promise<boolean>;
}
export interface PermitStopVerifier {
  verify(permit: HeldPermit): Promise<ExecutionStopResult[]>;
}

/** R59 recovery: only executor verification repeats; original work and failures remain untouched. */
export class StopVerification {
  private cursor = "";
  constructor(
    private readonly deps: {
      resources: ResourceStore;
      workflows: StopEvidenceReader;
      journal: StopVerificationStore;
      verifier: PermitStopVerifier;
      log: Logger;
      batchSize?: number;
      now?: () => Date;
    },
  ) {}

  async verify(
    permitId: string,
    release: (id: string) => Promise<unknown>,
  ): Promise<VerifyStopResult> {
    const result = await this.deps.journal.exclusive(() => this.verifyHeld(permitId, release));
    return result ?? { permitId, released: false, executions: [], reason: "verification_busy" };
  }

  async sweep(release: (id: string) => Promise<unknown>) {
    const ids = await this.candidates();
    const results: VerifyStopResult[] = [];
    for (const permitId of ids) {
      try {
        results.push(await this.verify(permitId, release));
      } catch (error) {
        const reason = errorCodeOf(error) ?? String(error);
        this.deps.log.warn({ permitId, err: error }, "permit stop sweep kept permit");
        results.push({ permitId, released: false, executions: [], reason });
      }
    }
    return {
      results,
      released: results.filter((item) => item.released).map((item) => item.permitId),
    };
  }

  private async candidates(): Promise<string[]> {
    const limit = this.deps.batchSize ?? 20;
    let ids = await this.deps.journal.candidates(limit, this.cursor);
    if (ids.length === 0 && this.cursor) {
      ids = await this.deps.journal.candidates(limit, "");
    }
    this.cursor = ids.at(-1) ?? "";
    return ids;
  }

  /**
   * Owner 2026-10-07: a permit granted to a workflow that closed before its gated work was scheduled holds nothing
   * (e.g. cancelled by a deploy right after the reservation). Temporal history is the proof; any execution or begun
   * activity keeps the normal executor rules.
   */
  private async unstarted(permit: HeldPermit): Promise<boolean> {
    const { workflows, journal } = this.deps;
    if ((permit.cleanup?.executions.length ?? 0) > 0 || !workflows.permitWorkScheduled) {
      return false;
    }
    if (await workflows.permitWorkScheduled(permit)) {
      return false;
    }
    return (await journal.settleUnstarted?.(permit)) ?? false;
  }

  /**
   * KAN-243 (2026-11-12): the owner closed so long ago that Temporal deleted it; with no execution left unproven
   * nothing of it can still run. Recorded executions keep the normal executor rules.
   */
  private async purged(permit: HeldPermit, release: (id: string) => Promise<unknown>) {
    if (permit.cleanup?.executions.some((entry) => entry.stoppedAt === null)) {
      return null;
    }
    if (!(await this.deps.journal.settlePurged?.(permit))) {
      return null;
    }
    await release(permit.permitId);
    this.deps.log.info(
      { permitId: permit.permitId, workflowId: permit.workflowId },
      "purged owner's permit released",
    );
    return { permitId: permit.permitId, released: true, executions: [], reason: "owner_purged" };
  }

  private async verifyHeld(permitId: string, release: (id: string) => Promise<unknown>) {
    const permit = await this.deps.resources.findHeld(permitId);
    if (!permit) {
      throw appErrors.create("PERMIT.NOT_FOUND", { details: { permitId } });
    }
    const owner = await requireClosedOwner(
      this.deps.workflows,
      permit,
      this.deps.now?.() ?? new Date(),
    );
    if (owner.status === PURGED_OWNER_STATUS) {
      const purged = await this.purged(permit, release);
      if (purged) {
        return purged;
      }
    } else if (await this.unstarted(permit)) {
      await release(permitId);
      this.deps.log.info({ permitId, workflowId: permit.workflowId }, "unstarted permit released");
      return { permitId, released: true, executions: [], reason: "work_never_scheduled" };
    }
    this.deps.log.info(
      { permitId, workflowId: permit.workflowId, runId: permit.runId },
      "verifying permit stop",
    );
    await this.deps.journal.attempted(permit);
    const executions = await this.deps.verifier.verify(permit);
    // Missing legacy execution identities cannot be manufactured from a closed workflow.
    if (executions.length > 0 && executions.every((item) => item.stopped)) {
      await this.deps.journal.finish(permit, null);
      await release(permitId);
      this.deps.log.info({ permitId, executions }, "permit stop verified and released");
      return { permitId, released: true, executions };
    }
    const reason = executions.length === 0 ? "execution_identity_missing" : "stop_not_proven";
    this.deps.log.warn({ permitId, executions, reason }, "permit stop remains unverified");
    return { permitId, released: false, executions, reason };
  }
}

/**
 * Closed owner is a prerequisite, never a substitute for executor proof. An owner Temporal deleted after its retention
 * counts as closed when its permit's grant time is known and older than that (KAN-243).
 */
export async function requireClosedOwner(
  reader: StopEvidenceReader,
  owner: PermitOwner & { grantedAt?: string },
  now: Date,
) {
  const evidence =
    (await reader.stopEvidence(owner.workflowId, owner.runId)) ?? purgedOwnerEvidence(owner, now);
  const verdict = stopVerdict(evidence ? { ...evidence, executionStopped: true } : null, now);
  if (verdict !== "stopped") {
    throw appErrors.create(
      verdict === "running" ? "PERMIT.OWNER_RUNNING" : "PERMIT.STOP_NOT_PROVEN",
      {
        details: { ...owner },
      },
    );
  }
  return evidence as NonNullable<typeof evidence>;
}
