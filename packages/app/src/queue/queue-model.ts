import { AmazonLinkBatchesSchema } from "@crawl-automation/v3-channels";
import { z } from "zod";

export const QueueStateSchema = z.enum(["queued", "ready", "running", "review", "completed"]);
export type QueueState = z.infer<typeof QueueStateSchema>;

/** A list of Amazon products to collect one by one; each product becomes one queue item. */
export const AddToQueueSchema = z.strictObject({
  campaignId: z.string().min(1).max(200),
  batches: AmazonLinkBatchesSchema,
});
export type AddToQueue = z.infer<typeof AddToQueueSchema>;

export const QueueItemsQuerySchema = z.strictObject({
  state: QueueStateSchema.default("running"),
  limit: z.number().int().min(1).max(10_000).default(200),
});
export type QueueItemsQuery = z.infer<typeof QueueItemsQuerySchema>;

/** Draining lets running products finish; forced stopping cancels them. */
export const PauseQueueSchema = z.strictObject({
  force: z.boolean().default(false),
  /** How long a drain may take before it turns into a forced stop; 0 means never. */
  graceSeconds: z.number().int().min(0).max(86_400).default(900),
});
export type PauseQueue = z.infer<typeof PauseQueueSchema>;

export const QueueLimitsSchema = z.strictObject({
  ready: z.number().int().min(1).max(1_000),
  running: z.number().int().min(1).max(1_000),
});
export type QueueLimits = z.infer<typeof QueueLimitsSchema>;

export const RequeueSchema = z.strictObject({
  itemIds: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(10_000),
});
export type Requeue = z.infer<typeof RequeueSchema>;

export interface QueueStatus {
  mode: "running" | "paused" | "draining" | "stopping";
  readyLimit: number;
  runningLimit: number;
  counts: Partial<Record<QueueState, number>>;
  /** Running products whose last check reported a problem. */
  attention: number;
}

export interface QueueItemView {
  itemId: string;
  campaignId: string;
  state: QueueState;
  attempt: number;
  requestId: string | null;
  asin: string | null;
  lastError: string | null;
  /** For Review items: the one-line reason. */
  reason: string | null;
}

/** The queue's tables; every change runs under the same lock as the queue runner. */
export interface QueueStore {
  status(): Promise<QueueStatus>;
  items(query: QueueItemsQuery): Promise<QueueItemView[]>;
  add(input: AddToQueue): Promise<{ added: number }>;
  setLimits(limits: QueueLimits): Promise<void>;
  pause(options: PauseQueue): Promise<void>;
  resume(): Promise<void>;
  requeue(input: Requeue): Promise<{ requeued: number }>;
}
