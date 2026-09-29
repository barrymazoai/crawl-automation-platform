import { z } from "zod";
import type { appErrors } from "../errors.js";
import type { ProductRun } from "../runs/run-model.js";
import type { QueueChannel, QueueMode } from "./queue-model.js";

export interface QueueControl {
  channel: QueueChannel;
  mode: QueueMode;
  readyLimit: number;
  runningLimit: number;
}

/** An item that was started: its product run, and whether a forced stop was already asked for. */
export interface StartedItem {
  itemId: string;
  channel: QueueChannel;
  runId: string;
  sourceId: string;
  url: string;
  stopRequested: boolean;
}

/** How an item ended. The reason is the Review's failure code; null when completed. */
export interface SettledOutcome {
  state: "completed" | "review";
  reason: string | null;
}

/** The shared queue tables as the dispatcher moves items through them. */
export interface DispatchStore {
  /** Every channel's control row; a drain past its deadline with work running becomes a forced stop first. */
  controls(): Promise<QueueControl[]>;
  running(channel: QueueChannel): Promise<StartedItem[]>;
  /** Queued -> ready, oldest first, up to the ready limit. */
  fillReady(control: QueueControl): Promise<void>;
  /** Ready -> running while fewer than the running limit run; each gets a new attempt and a new run ID. */
  claim(control: QueueControl): Promise<StartedItem[]>;
  settle(item: StartedItem, outcome: SettledOutcome): Promise<void>;
  markStopRequested(item: StartedItem): Promise<void>;
  /** A draining or stopping channel with nothing running becomes paused. */
  pauseIfIdle(channel: QueueChannel): Promise<void>;
}

/** What Temporal shows about a product run's workflow; `MISSING` when it was never started. */
export interface RunExecution {
  status: string;
  /** The workflow's result once it completed; null otherwise. */
  result: unknown;
}

export interface RunExecutions {
  execution(runId: string): Promise<RunExecution>;
}

/** Starts a product run: the same path `runs.submit` uses. Repeating a request only finishes its first start. */
export interface ProductStarter {
  submit(run: ProductRun): Promise<string>;
}

export interface RunCanceller {
  cancel(runId: string): Promise<unknown>;
}

/** A reason recorded on a Review item: a code from the application's error registry. */
export type QueueReason = keyof typeof appErrors.codes;

// A label assembly Review names its causes as `codes`; every other Review as `code`.
const PipelineResultSchema = z.object({
  status: z.string(),
  code: z.string().optional(),
  codes: z.array(z.string()).optional(),
});

/** Temporal statuses of a workflow that ended without completing, and the reason each is recorded with. */
const endedReasons: Partial<Record<string, QueueReason>> = {
  FAILED: "QUEUE.RUN_FAILED",
  CANCELLED: "QUEUE.RUN_CANCELLED",
  TERMINATED: "QUEUE.RUN_TERMINATED",
  TIMED_OUT: "QUEUE.RUN_TIMED_OUT",
};

/**
 * How a product run ended, from its workflow: `collected` or `listing` is completed; a pipeline Review keeps its code; a
 * workflow that ended any other way is a Review naming how. Null while it runs or was never started.
 */
export function settledOutcome(execution: RunExecution): SettledOutcome | null {
  if (execution.status === "COMPLETED") {
    return completedOutcome(execution.result);
  }
  const ended = endedReasons[execution.status];
  return ended ? { state: "review", reason: ended } : null;
}

/** A completed run: collected or unlisted is done; a Review keeps its own code; anything else is unrecognized. */
function completedOutcome(raw: unknown): SettledOutcome {
  const result = PipelineResultSchema.safeParse(raw);
  // `listing`: the revisit found the listing unlisted and recorded that sighting with its reason; the run is done.
  if (result.success && ["collected", "listing"].includes(result.data.status)) {
    return { state: "completed", reason: null };
  }
  if (!result.success || result.data.status !== "review") {
    return { state: "review", reason: "QUEUE.OUTCOME_UNRECOGNIZED" };
  }
  return {
    state: "review",
    reason: result.data.code ?? result.data.codes?.[0] ?? "QUEUE.RUN_REVIEW",
  };
}
