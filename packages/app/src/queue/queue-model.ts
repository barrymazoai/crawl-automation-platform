import { AmazonLinkBatchesSchema } from "@crawl-automation/v3-channels";
import { ChannelIdSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** Every channel has its own queue: its own mode and limits. */
export const QueueChannelSchema = ChannelIdSchema;
export type QueueChannel = z.infer<typeof QueueChannelSchema>;

export const QueueStateSchema = z.enum(["queued", "ready", "running", "review", "completed"]);
export type QueueState = z.infer<typeof QueueStateSchema>;

/** The queue a call is about; Amazon unless named. */
const channel = QueueChannelSchema.default("amazon");

export const ChannelQueueSchema = z.strictObject({ channel });
export type ChannelQueue = z.infer<typeof ChannelQueueSchema>;

/** One product page to collect: its brand source, its page, and the channel's own product ID. */
export const QueuedProductSchema = z.strictObject({
  sourceId: z.uuid(),
  url: z.url({ protocol: /^https$/ }).max(4096),
  /** The channel's product ID: ASIN, SKU or product handle. */
  listingId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200).nullable().default(null),
});
export type QueuedProduct = z.infer<typeof QueuedProductSchema>;

/**
 * A product list: Amazon link batches (Amazon's existing queue), or products of any other channel. The list ID
 * makes adding the same list twice add nothing.
 */
export const AddToQueueSchema = z.discriminatedUnion("channel", [
  z.strictObject({
    channel: z.literal("amazon"),
    campaignId: z.string().min(1).max(200),
    batches: AmazonLinkBatchesSchema,
  }),
  z.strictObject({
    channel: QueueChannelSchema.exclude(["amazon"]),
    batchId: z.uuid(),
    label: z.string().min(1).max(200),
    products: z.array(QueuedProductSchema).min(1).max(10_000),
  }),
]);
export type AddToQueue = z.infer<typeof AddToQueueSchema>;
export type AddProducts = Exclude<AddToQueue, { channel: "amazon" }>;

export const QueueItemsQuerySchema = z.strictObject({
  channel,
  state: QueueStateSchema.default("running"),
  limit: z.number().int().min(1).max(10_000).default(200),
});
export type QueueItemsQuery = z.infer<typeof QueueItemsQuerySchema>;

/** Draining lets running products finish; forced stopping cancels them. */
export const PauseQueueSchema = z.strictObject({
  channel,
  force: z.boolean().default(false),
  /** How long a drain may take before it turns into a forced stop; 0 means never. */
  graceSeconds: z.number().int().min(0).max(86_400).default(900),
});
export type PauseQueue = z.infer<typeof PauseQueueSchema>;

export const QueueLimitsSchema = z.strictObject({
  channel,
  ready: z.number().int().min(1).max(1_000),
  running: z.number().int().min(1).max(1_000),
});
export type QueueLimits = z.infer<typeof QueueLimitsSchema>;

export const RequeueSchema = z.strictObject({
  channel,
  itemIds: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(10_000),
});
export type Requeue = z.infer<typeof RequeueSchema>;

export type QueueMode = "running" | "paused" | "draining" | "stopping";

export interface QueueStatus {
  channel: QueueChannel;
  mode: QueueMode;
  readyLimit: number;
  runningLimit: number;
  counts: Partial<Record<QueueState, number>>;
  /** Running products whose last check reported a problem. */
  attention: number;
}

export interface QueueItemView {
  itemId: string;
  /** The list the item came from: its campaign (Amazon) or batch ID. */
  batch: string;
  state: QueueState;
  attempt: number;
  /** The current attempt's product run (Amazon: its request). */
  runId: string | null;
  listingId: string | null;
  lastError: string | null;
  /** For Review items: the one-line reason or failure code. */
  reason: string | null;
}

/** One channel's queue tables; every change runs under the queue's lock. */
export interface QueueStore {
  status(channel: QueueChannel): Promise<QueueStatus>;
  items(query: QueueItemsQuery): Promise<QueueItemView[]>;
  add(input: AddToQueue): Promise<{ added: number }>;
  setLimits(limits: QueueLimits): Promise<void>;
  pause(options: PauseQueue): Promise<void>;
  resume(channel: QueueChannel): Promise<void>;
  requeue(input: Requeue): Promise<{ requeued: number }>;
}
