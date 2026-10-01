import { defineErrors } from "@crawl-automation/platform";

export interface QueueAttempt {
  runId: string;
  itemId: string;
  channel: string;
  attempt: number;
  startedAt: string;
  settledAt: string | null;
  outcome: "running" | "completed" | "review" | "pending";
  reason: string | null;
}

/** Writes belong in the same transaction that moves the queue item. No automatic requeue. */
export interface QueueAttempts {
  start(input: Pick<QueueAttempt, "runId" | "itemId" | "channel" | "attempt">): Promise<void>;
  finish(input: Pick<QueueAttempt, "runId" | "outcome" | "reason">): Promise<void>;
  list(itemId: string): Promise<QueueAttempt[]>;
}

export const usageErrors = defineErrors({
  "USAGE.ATTEMPT_CONFLICT": {
    category: "VALIDATION",
    message: "Queue attempt identity or outcome conflicts with recorded history.",
  },
});
