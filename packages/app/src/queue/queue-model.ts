import { ChannelIdSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { FamilyFormulaOutcomes } from "./family-formula-outcome.js";
import { QueueFilterFields } from "./queue-filters.js";
import type { QueueSourceSummary, QueueSummaryQuery } from "./queue-summary.js";
import { QueueStateSchema, type QueueState } from "./queue-state.js";
import type { QueueAddResult, ScanAdmissionSettings } from "./scan-admission.js";
export * from "./scan-admission.js";
export * from "./family-formula-outcome.js";
export * from "./queue-summary.js";
export * from "./queue-state.js";

/** Every channel has its own queue: its own mode and limits. */
export const QueueChannelSchema = ChannelIdSchema;
export type QueueChannel = z.infer<typeof QueueChannelSchema>;

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

/** A product list for any channel. Its ID makes adding the same list twice add nothing. */
export const AddToQueueSchema = z.strictObject({
  channel: QueueChannelSchema,
  batchId: z.uuid(),
  label: z.string().min(1).max(200),
  products: z.array(QueuedProductSchema).min(1).max(10_000),
});
export type AddToQueue = z.infer<typeof AddToQueueSchema>;
export type AddProducts = AddToQueue;

/** Eligible legacy items still to copy, and eligible items already present in the shared queue. */
export interface AmazonMigrationPreview {
  pending: number;
  alreadyCopied: number;
}

/** Read-only access to Amazon's retired queue. */
export interface AmazonQueueHistory {
  migrationPreview(): Promise<AmazonMigrationPreview>;
}

export const QueueItemsQuerySchema = z.strictObject({
  ...QueueFilterFields,
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

const RequeueIdsSchema = z.strictObject({
  channel,
  itemIds: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(10_000),
});
export const RequeueFilterSchema = z.strictObject({
  channel,
  filter: z.strictObject({ ...QueueFilterFields, state: z.literal("review") }),
  limit: z.number().int().min(1).max(10_000),
  dryRun: z.boolean().default(true),
});
export const RequeueSchema = z.union([RequeueIdsSchema, RequeueFilterSchema]);
export type Requeue = z.infer<typeof RequeueSchema>;
export type RequeueResult =
  { requeued: number } | { dryRun: true; count: number; sample: QueueItemView[] };

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
  /** The list the item came from: its batch ID. */
  batch: string;
  state: QueueState;
  attempt: number;
  /** The current attempt's product run. */
  runId: string | null;
  listingId: string | null;
  sourceId: string;
  updatedAt: string;
  lastError: string | null;
  /** For Review items: the one-line reason or failure code. */
  reason: string | null;
  /** The active request this batch follows; followers never create their own execution. */
  followsItemId?: string | null | undefined;
}

/** One channel's queue tables; every change runs under the queue's lock. */
export interface QueueStore extends Partial<FamilyFormulaOutcomes> {
  status(channel: QueueChannel): Promise<QueueStatus>;
  items(query: QueueItemsQuery): Promise<QueueItemView[]>;
  summary(query: QueueSummaryQuery): Promise<QueueSourceSummary[]>;
  add(input: AddToQueue, discovery?: ScanAdmissionSettings): Promise<QueueAddResult>;
  setLimits(limits: QueueLimits): Promise<void>;
  pause(options: PauseQueue): Promise<void>;
  resume(channel: QueueChannel): Promise<void>;
  requeue(input: Requeue): Promise<RequeueResult>;
}
