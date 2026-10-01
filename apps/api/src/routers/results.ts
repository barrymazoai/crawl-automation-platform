import {
  ProductListSchema,
  ReviewRecheckInputSchema,
  ReviewRecoveryInputSchema,
} from "@crawl-automation/app";
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

  /** The full Review record with its evidence files from R2 (raw content; private network only). */
  evidence: procedure
    .input(ReviewIdSchema)
    .query(({ ctx, input }) => ctx.reviews.evidence(input.reviewId)),

  /** Whether stored model answers pass today's decoding rules. Reads only: no model call, no writes. */
  recheck: procedure
    .input(ReviewRecheckInputSchema)
    .query(({ ctx, input }) => ctx.reviews.recheck(input)),

  /** Manual recovery: dry run first, then publish that preview using retained answers only. */
  recover: procedure
    .input(ReviewRecoveryInputSchema)
    .mutation(({ ctx, input }) => ctx.reviews.recover(input)),
});

export const productsRouter = router({
  /** Collected products, newest first; pass `nextCursor` as `before` for the next page. */
  list: procedure
    .input(ProductListSchema.optional())
    .query(({ ctx, input }) => ctx.products.list(ProductListSchema.parse(input ?? {}))),

  /** One collected product with its full stored record (formula, ingredients, assembly). */
  get: procedure
    .input(z.strictObject({ operationId: z.string().min(1).max(120) }))
    .query(({ ctx, input }) => ctx.products.get(input.operationId)),
});
