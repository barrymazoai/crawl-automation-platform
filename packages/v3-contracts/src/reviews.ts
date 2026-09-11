import { z } from "zod";
import { ExecutionIdSchema, ObservationSchema, Sha256Schema } from "./artifacts.js";
import { OcrInputSchema, ReviewSchema, ErrorCategorySchema, ReviewCodeSchema } from "./processing.js";
import { Id } from "./brands.js";
/** Private journal payload, not an HTTP response. Never silently truncate evidence. */
export const ReviewRecordSchema = z.strictObject({
    schemaVersion: z.literal(1),
    reviewId: ExecutionIdSchema,
    occurredAt: z.iso.datetime(),
    failure: ReviewSchema,
    observation: ObservationSchema.nullable(),
    rawError: z.strictObject({ name: z.string().min(1).max(200), message: z.string(), stack: z.string().nullable(), details: z.json() }),
    // null explicitly means no candidate existed at the failed stage.
    candidate: z.strictObject({ schema: z.string().min(1).max(100), value: z.json() }).nullable(),
    inspection: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("none") }),
        z.strictObject({ kind: z.literal("workflow-delivery"), requestId: Id }),
        z.strictObject({ kind: z.literal("ocr-result"), input: OcrInputSchema }),
    ]),
}).superRefine((record, ctx) => {
    const f = record.failure, o = record.observation, target = record.inspection;
    if (o && (o.requestId !== f.requestId || o.observationId !== f.observationId))
        ctx.addIssue({ code: "custom", message: "Review observation identity mismatch" });
    if (target.kind === "workflow-delivery" && target.requestId !== f.requestId)
        ctx.addIssue({ code: "custom", message: "Delivery request mismatch" });
    if (target.kind === "ocr-result") {
        const input = target.input;
        if (!o || input.requestId !== f.requestId || input.observationId !== f.observationId ||
            input.operationId !== f.operationId || input.inputFingerprint !== f.inputFingerprint ||
            input.brandId !== o.brandId || input.sourceId !== o.sourceId || input.listingId !== o.listingId || input.variantId !== o.variantId)
            ctx.addIssue({ code: "custom", message: "Result inspection identity mismatch" });
    }
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
export const ReviewListQuerySchema = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: ExecutionIdSchema.optional(),
    requestId: ExecutionIdSchema.optional(), operationId: ExecutionIdSchema.optional(),
    brandId: ExecutionIdSchema.optional(), sourceId: ExecutionIdSchema.optional(),
    category: ErrorCategorySchema.optional(), code: ReviewCodeSchema.optional(),
    executionFact: ReviewSchema.shape.executionFact.optional(),
    stage: ReviewSchema.shape.stage.optional(), blockedBy: ExecutionIdSchema.optional(),
});
export type ReviewListQuery = z.infer<typeof ReviewListQuerySchema>;
export const ReviewReceiptSchema = z.strictObject({ reviewId: ExecutionIdSchema, recordHash: Sha256Schema, registered: z.literal(true) });
