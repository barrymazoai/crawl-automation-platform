import { ProductListSchema } from "@crawl-automation/app";
import { ReviewListQuerySchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { procedure, router } from "../trpc.js";

const ReviewIdSchema = z.strictObject({ reviewId: z.string().min(1).max(120) });

export const reviewsRouter = router({
  list: procedure
    .input(ReviewListQuerySchema.optional())
    .query(({ ctx, input }) => ctx.reviews.list(ReviewListQuerySchema.parse(input ?? {}))),

  /** Counts by category and code. */
  summary: procedure.query(({ ctx }) => ctx.reviews.summary()),

  get: procedure.input(ReviewIdSchema).query(({ ctx, input }) => ctx.reviews.get(input.reviewId)),

  /** The Review with its retained evidence checked. */
  inspect: procedure
    .input(ReviewIdSchema)
    .query(({ ctx, input }) => ctx.reviews.inspect(input.reviewId)),
});

export const productsRouter = router({
  /** Collected products, newest first; pass `nextCursor` as `before` for the next page. */
  list: procedure
    .input(ProductListSchema.optional())
    .query(({ ctx, input }) => ctx.products.list(ProductListSchema.parse(input ?? {}))),
});
