import { z } from "zod";

/** A queue's status row: mode, limits, item counts by state, and running items needing attention. */
export const StatusRow = z.object({
  mode: z.enum(["running", "paused", "draining", "stopping"]),
  readyLimit: z.number(),
  runningLimit: z.number(),
  counts: z.record(z.string(), z.number()),
  attention: z.number(),
});

/** One queue item as the item listing shows it, for Amazon's queue and the shared queue alike. */
export const ItemRow = z.object({
  itemId: z.string(),
  batch: z.string(),
  state: z.enum(["queued", "ready", "running", "following", "pending", "review", "completed"]),
  followsItemId: z.string().nullable().optional(),
  attempt: z.number(),
  runId: z.string().nullable(),
  listingId: z.string().nullable(),
  lastError: z.string().nullable(),
  reason: z.string().nullable(),
});
