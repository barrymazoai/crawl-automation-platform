import type { Logger } from "@crawl-automation/platform";
import { differenceInSeconds } from "date-fns";
import { appErrors } from "../errors.js";
import type { PermitStore, RunStore, WorkflowTree } from "./ports.js";
import type { RunDetail, RunFilter, RunSummary, SubmitRun, WorkflowMember } from "./run-model.js";

/** A stopped workflow's last Activity may still be finishing; wait this long before settling. */
const SETTLE_AFTER_SECONDS = 120;
const CANCEL_BATCH = 20;

export interface RunServiceDeps {
  runs: RunStore;
  tree: WorkflowTree;
  permits: PermitStore;
  log: Logger;
  now?: () => Date;
}

export interface SettleResult {
  runId: string;
  permitsReleased: number;
  guardReleased: boolean;
}

export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  /** Accepts a run. The delivery runner starts its workflow within seconds. */
  async submit(run: SubmitRun): Promise<RunSummary> {
    const accepted = await this.deps.runs.accept(run);
    this.deps.log.info({ runId: accepted.runId, channel: accepted.channel }, "run accepted");
    return accepted;
  }

  list(filter: RunFilter): Promise<RunSummary[]> {
    return this.deps.runs.list(filter);
  }

  async get(runId: string): Promise<RunDetail> {
    const summary = await this.summary(runId);
    const members = await this.deps.tree.members(summary.workflowId);
    const [progress, heldPermits] = await Promise.all([
      this.deps.runs.catalogProgress(runId),
      this.deps.permits.heldBy(memberIds(summary, members)),
    ]);
    return { ...summary, progress, workflows: countByTypeAndStatus(members), heldPermits };
  }

  /** Cancels every running workflow of the run, including abandoned children. */
  async cancel(runId: string): Promise<{ runId: string; cancelled: number }> {
    const summary = await this.summary(runId);
    const running = (await this.deps.tree.members(summary.workflowId)).filter(isRunning);
    for (let start = 0; start < running.length; start += CANCEL_BATCH) {
      const batch = running.slice(start, start + CANCEL_BATCH);
      await Promise.all(batch.map((member) => this.deps.tree.cancel(member.workflowId)));
    }
    this.deps.log.info({ runId, cancelled: running.length }, "run cancelled");
    return { runId, cancelled: running.length };
  }

  /**
   * Releases what a finished run still holds: its permits and its source guard. Refused while any of its
   * workflows runs or stopped less than two minutes ago.
   */
  async settle(runId: string): Promise<SettleResult> {
    const summary = await this.summary(runId);
    const members = await this.deps.tree.members(summary.workflowId);
    this.assertSettleable(runId, members);
    const held = await this.deps.permits.heldBy(memberIds(summary, members));
    const permitIds = held.map((permit) => permit.permitId);
    const result = await this.deps.runs.settle(runId, permitIds);
    this.deps.log.info({ runId, ...result }, "run settled");
    return { runId, ...result };
  }

  private assertSettleable(runId: string, members: WorkflowMember[]): void {
    if (members.some(isRunning)) {
      throw appErrors.create("RUN.STILL_RUNNING", { details: { runId } });
    }
    const now = this.deps.now?.() ?? new Date();
    const recent = members.some(
      (member) =>
        member.closedAt && differenceInSeconds(now, member.closedAt) < SETTLE_AFTER_SECONDS,
    );
    if (recent) {
      throw appErrors.create("RUN.RECENTLY_STOPPED", { details: { runId } });
    }
  }

  private async summary(runId: string): Promise<RunSummary> {
    const summary = await this.deps.runs.find(runId);
    if (!summary) {
      throw appErrors.create("RUN.NOT_FOUND", { details: { runId } });
    }
    return summary;
  }
}

function isRunning(member: WorkflowMember): boolean {
  return member.status === "RUNNING";
}

function memberIds(summary: RunSummary, members: WorkflowMember[]): string[] {
  return [...new Set([summary.workflowId, ...members.map((member) => member.workflowId)])];
}

function countByTypeAndStatus(members: WorkflowMember[]): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const member of members) {
    const byStatus = (counts[member.type] ??= {});
    byStatus[member.status] = (byStatus[member.status] ?? 0) + 1;
  }
  return counts;
}
