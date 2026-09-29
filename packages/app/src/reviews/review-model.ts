import { ReviewListQuerySchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

export const ReviewIdSchema = z.string().min(1).max(120);

/** Recheck one Review, or up to 100 Reviews matching a filter (newest first). */
export const ReviewRecheckInputSchema = z.union([
  z.strictObject({ reviewId: ReviewIdSchema }),
  z.strictObject({
    filter: ReviewListQuerySchema.omit({ limit: true }),
    limit: z.number().int().min(1).max(100).default(25),
  }),
]);
export type ReviewRecheckInput = z.infer<typeof ReviewRecheckInputSchema>;

/** A page of Reviews as the ledger lists them; only the IDs are used here. */
export const ReviewPageSchema = z.object({
  items: z.array(z.object({ reviewId: ReviewIdSchema })),
});
