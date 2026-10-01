import { z } from "zod";

/** Exact matches within an array; different filters are combined with AND. Empty arrays are refused. */
export const QueueFilterFields = {
  reasons: z.array(z.string().min(1).max(200)).min(1).max(1_000).optional(),
  updatedSince: z.iso.datetime({ offset: true }).optional(),
  createdSince: z.iso.datetime({ offset: true }).optional(),
  sourceIds: z.array(z.uuid()).min(1).max(10_000).optional(),
  listingIds: z.array(z.string().min(1).max(200)).min(1).max(10_000).optional(),
};
