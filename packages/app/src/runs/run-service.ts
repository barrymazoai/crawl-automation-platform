import type { Logger } from "@crawl-automation/platform";
import { appErrors } from "../errors.js";
import { judgePermits } from "../stops/judge-permits.js";
import type { BrandScanService } from "../brand-scans/brand-scan-service.js";
import type { ListRuns } from "./list-runs.js";
import type { PermitStore, RunStore, WorkflowTree } from "./ports.js";
import type { ProductRuns } from "./product-runs.js";
import type {
  BrandRun,
  ListRunSummary,
  RunDetail,
  RunFilter,
  RunSummary,
  SubmitRun,
  WorkflowMember,
} from "./run-model.js";

const CANCEL_BATCH = 20;
/** How many ended-but-unsettled runs one cleanup sweep looks at. */
const SWEEP_LIMIT = 200;

export interface RunServiceDeps {
  runs: RunStore;
  tree: WorkflowTree;
  permits: PermitStore;
  productRuns: Pick<ProductRuns, "submit">;
  listRuns: Pick<ListRuns, "submit">;
  /** A brand run's scan, requested when the run is accepted; its CollectionWorkflow waits for it. */
  brandScans: Pick<BrandScanService, "request">;
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

  /**
   * Accepts a run. A brand run's scan is requested and its CollectionWorkflow started by the delivery runner within
   * seconds; a product run's workflow is started before this returns; a list run's pages are queued.
   */
  async submit(run: SubmitRun): Promise<RunSummary | ListRunSummary> {
    const accepted =
      run.kind === "brand"
        ? await this.acceptBrand(run)
        : run.kind === "list"
          ? await this.deps.listRuns.submit(run)
          : await this.summary(await this.deps.productRuns.submit(run));
    this.deps.log.info({ runId: accepted.runId, kind: run.kind }, "run accepted");
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
   * Releases what an ended run still holds: its permits and its source guard. Refused while any of its
   * workflows runs, or while a permit's owner has not provably stopped.
   */
  async settle(runId: string): Promise<SettleResult> {
    const summary = await this.summary(runId);
    const members = await this.deps.tree.members(summary.workflowId);
    if (members.some(isRunning)) {
      throw appErrors.create("RUN.STILL_RUNNING", { details: { runId } });
    }
    const held = await this.deps.permits.heldBy(memberIds(summary, members));
    const judged = await judgePermits(held, this.deps.tree, this.now());
    const unproven = judged.filter((entry) => entry.verdict !== "stopped");
    if (unproven.length > 0) {
      const workflows = unproven.map((entry) => entry.permit.workflowId);
      throw appErrors.create("RUN.STOP_NOT_PROVEN", { details: { runId, workflows } });
    }
    const result = await this.deps.runs.settle(
      runId,
      held.map((permit) => permit.permitId),
    );
    this.deps.log.info({ runId, ...result }, "run settled");
    return { runId, ...result };
  }

  /**
   * Settles runs whose root ended without a clean completion (failed or cancelled) once nothing of theirs runs
   * or holds a permit. Permits are released separately, by evidence, before this runs.
   */
  async settleStopped(): Promise<SettleResult[]> {
    const active = await this.deps.runs.list({ active: true, limit: SWEEP_LIMIT });
    const ended = active.filter((run) => run.delivery?.lastIssue === "UNCONFIRMED_TERMINAL");
    const settled: SettleResult[] = [];
    for (const run of ended) {
      const members = await this.deps.tree.members(run.workflowId);
      const held = await this.deps.permits.heldBy(memberIds(run, members));
      if (members.length > 0 && !members.some(isRunning) && held.length === 0) {
        settled.push({ runId: run.runId, ...(await this.deps.runs.settle(run.runId, [])) });
        this.deps.log.info({ runId: run.runId }, "ended run settled automatically");
      }
    }
    return settled;
  }

  /** The scan first (asking again returns the same scan), then the run that waits for it. */
  private async acceptBrand(run: BrandRun): Promise<RunSummary> {
    await this.deps.brandScans.request({ requestId: run.requestId, sourceIds: [run.sourceId] });
    return this.deps.runs.accept(run);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
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
