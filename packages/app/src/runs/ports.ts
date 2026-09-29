import type {
  BrandRun,
  CatalogProgress,
  HeldPermit,
  RunFilter,
  RunSummary,
  WorkflowMember,
} from "./run-model.js";
import type { StopEvidence } from "../stops/stop-policy.js";

/** Runs as stored in Postgres (submission, source guard, delivery record, catalog tables). */
export interface RunStore {
  /** Accepts a brand run; repeating the same request ID returns the same run. */
  accept(run: BrandRun): Promise<RunSummary>;
  list(filter: RunFilter): Promise<RunSummary[]>;
  find(runId: string): Promise<RunSummary | null>;
  catalogProgress(runId: string): Promise<CatalogProgress>;
  /** Releases the given permits and the run's source guard in one transaction. */
  settle(
    runId: string,
    permitIds: string[],
  ): Promise<{ permitsReleased: number; guardReleased: boolean }>;
}

/** Every workflow that belongs to a run, found by its root workflow. */
export interface WorkflowTree {
  members(rootWorkflowId: string): Promise<WorkflowMember[]>;
  cancel(workflowId: string): Promise<void>;
  /** What Temporal shows about one execution; null when Temporal cannot find it. */
  stopEvidence(workflowId: string, runId: string): Promise<StopEvidence | null>;
}

export interface PermitStore {
  heldBy(workflowIds: string[]): Promise<HeldPermit[]>;
}
