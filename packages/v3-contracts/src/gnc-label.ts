import { z } from "zod";
import { ExecutionIdSchema, ObjectKeySchema, Sha256Schema } from "./artifacts.js";
import { GncProductInputSchema } from "./gnc-product.js";
import { TextCompatibilitySchema } from "./text.js";
import { LabelProductManifestSchema, LabelProductWorkflowInputSchema, LabelProductSourceSchema, LabelEvidencePolicySchema } from "./label-product.js";
import { SavedProductWorkflowInputSchema } from "./product-evidence.js";
import { ResourceGateSchema } from "./resources.js";
export const GncLabelInputSchema = z.strictObject({ operationId: ExecutionIdSchema, sourcePlan: GncProductInputSchema,
  text: TextCompatibilitySchema.refine(t => t.resultSchemaVersion === 3), visionConfigFingerprint: Sha256Schema,
  corePolicy: z.literal("gnc-label-core/1").optional(),
  evidencePolicy: LabelEvidencePolicySchema.optional(),
}).refine(i => ![i.sourcePlan.operationId, i.sourcePlan.task.capture.operationId].includes(i.operationId));
export type GncLabelInput = z.infer<typeof GncLabelInputSchema>;
export const GncLabelOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("prepared"), input: GncLabelInputSchema, evidenceKey: ObjectKeySchema, manifest: LabelProductManifestSchema,
    skipped: z.array(ExecutionIdSchema).max(100) }),
  z.strictObject({ status: z.literal("review"), operationId: ExecutionIdSchema, reviewId: ExecutionIdSchema, code: z.string().min(1), automaticRetry: z.literal(false) }),
]);
export type GncLabelOutcome = z.infer<typeof GncLabelOutcomeSchema>;
export const GncPreparedLabelWorkflowInputSchema = z.strictObject({ input: GncLabelInputSchema,
  queues: LabelProductWorkflowInputSchema.shape.queues.extend({ prepare: z.string().min(1).max(255) }) });
export const GncLabelPlanOutcomeSchema = z.strictObject({ input: GncLabelInputSchema,
  manifest: SavedProductWorkflowInputSchema.shape.manifest.refine(m => m.sources.every(s => s.kind === "page" || s.kind === "file-image")) });
export const GncLabelSourceInputSchema = z.strictObject({ input: GncLabelInputSchema, sourceId: ExecutionIdSchema });
export const GncLabelSourceOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("prepared"), input: GncLabelSourceInputSchema, source: LabelProductSourceSchema }),
  z.strictObject({ status: z.literal("not_matched"), input: GncLabelSourceInputSchema }),
]);
export type GncLabelSourceOutcome = z.infer<typeof GncLabelSourceOutcomeSchema>;
const queue = z.string().min(1).max(255);
export const GncStreamingLabelWorkflowInputSchema = z.strictObject({ input: GncLabelInputSchema, start: z.enum(["capture", "saved-plan"]), resources: ResourceGateSchema.optional(),
  queues: LabelProductWorkflowInputSchema.shape.queues.extend({ plan: queue, source: queue, manifest: queue,
    page: queue, pageText: queue, core: queue.optional(), acquire: queue, acquireReceipts:queue.optional(),imagePrepare: queue, ocr: queue, ocrReceipts: queue, keywords: queue,
    capture: queue.optional(), captureReceipts: queue.optional(), productPlan: queue.optional() }),
}).refine(i => i.start !== "capture" || Boolean(i.queues.capture && i.queues.captureReceipts && i.queues.productPlan), "Capture queues required")
  .refine(i => Boolean(i.input.corePolicy) === Boolean(i.queues.core), "Explicit core policy and queue required together");
