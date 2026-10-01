import { ChannelIdSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { QueueFilterFields } from "./queue-filters.js";
import type { QueueState } from "./queue-state.js";

export const QueueSummaryQuerySchema = z.strictObject({
  channel: ChannelIdSchema.default("amazon"),
  sourceIds: QueueFilterFields.sourceIds,
  createdSince: QueueFilterFields.createdSince,
  /** Exact scan request membership, using discovery batches only (not missing-listing revisits). */
  requestId: z.uuid().optional(),
});
export type QueueSummaryQuery = z.infer<typeof QueueSummaryQuerySchema>;

/** Current queue rows, not distinct listings or historical attempt counts. Empty sources have total 0. */
export interface QueueSourceSummary {
  sourceId: string;
  brandId: string;
  brandName: string;
  total: number;
  counts: Partial<Record<QueueState, number>>;
  reviewReasons: { reason: string | null; count: number }[];
}
