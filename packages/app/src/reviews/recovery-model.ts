import { z } from "zod";
import {
  ExecutionIdSchema,
  ReviewListQuerySchema,
  Sha256Schema,
} from "@crawl-automation/v3-contracts";

const selection = z.union([
  z.strictObject({
    reviewIds: z
      .array(ExecutionIdSchema)
      .min(1)
      .max(25)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate Review IDs"),
  }),
  z.strictObject({
    filter: ReviewListQuerySchema.omit({ limit: true }),
    limit: z.number().int().min(1).max(25),
  }),
]);
export const ReviewRecoveryInputSchema = z.union([
  z.strictObject({ dryRun: z.literal(true).default(true), selection }),
  z.strictObject({ dryRun: z.literal(false), previewId: z.uuid() }),
]);
export type ReviewRecoveryInput = z.infer<typeof ReviewRecoveryInputSchema>;

export const RecoveryItemSchema = z.strictObject({
  reviewId: ExecutionIdSchema,
  originalReviewHash: Sha256Schema.nullable(),
  status: z.enum(["recoverable", "review", "unavailable", "recovered"]),
  codes: z.array(z.string()),
  digest: Sha256Schema.nullable(),
  operationId: ExecutionIdSchema.nullable(),
});
export type RecoveryItem = z.infer<typeof RecoveryItemSchema>;
export const RecoveryPreviewSchema = z.strictObject({
  previewId: z.uuid(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  items: z.array(RecoveryItemSchema).max(25),
});
export type RecoveryPreview = z.infer<typeof RecoveryPreviewSchema>;

export const RecoveryOutcomeSchema = z.strictObject({
  ...RecoveryItemSchema.shape,
  previewId: z.uuid(),
  recordedAt: z.iso.datetime(),
  superseded: z.boolean(),
  recordHash: Sha256Schema.nullable(),
});
export type RecoveryOutcome = z.infer<typeof RecoveryOutcomeSchema>;
