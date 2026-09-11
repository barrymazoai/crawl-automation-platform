import { z } from "zod";
import { ExecutionIdSchema, ArtifactRefSchema, Sha256Schema, ObjectKeySchema } from "./artifacts.js";
import { GncAcquireInputSchema, GncAcquireOutcomeSchema, GncAcquiredRecordSchema } from "./gnc-acquisition.js";
import { TextCompatibilitySchema } from "./text.js";
import { ProcessingCompatibilitySchema } from "./processing.js";
import { SavedProductWorkflowInputSchema } from "./product-evidence.js";
export const GncProductInputSchema = z.strictObject({ operationId: ExecutionIdSchema,
  task: GncAcquireInputSchema.refine(t => t.capture.kind === "product"),
  // Omitted means the original immutable capture result. Opt-in requires a NEW product operation.
  parseVersion: z.literal("gnc-product-html/2").optional(),
  text: TextCompatibilitySchema.refine(c => c.resultSchemaVersion === 2),
  ocr: ProcessingCompatibilitySchema.refine(c => c.resultSchemaVersion === 2), visionConfigFingerprint: Sha256Schema,
}).refine(i => i.operationId !== i.task.capture.operationId, "Capture and product operations must differ");
export type GncProductInput = z.infer<typeof GncProductInputSchema>;
export const GncProductPrepareSchema = z.strictObject({ input: GncProductInputSchema, receipt: GncAcquireOutcomeSchema.nullable() });
export const GncProductPlanSchema = z.strictObject({ codec: z.literal("gnc-product-plan/1"), input: GncProductInputSchema,
  capture: GncAcquiredRecordSchema, parsed: ArtifactRefSchema.refine(a => a.kind === "result-json").optional(),
  fragment: ArtifactRefSchema.nullable(), manifest: SavedProductWorkflowInputSchema.shape.manifest });
export type GncProductPlan = z.infer<typeof GncProductPlanSchema>;
export const GncProductPrepareOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("prepared"), operationId: ExecutionIdSchema, inputFingerprint: Sha256Schema,
    evidenceKey: ObjectKeySchema, manifest: SavedProductWorkflowInputSchema.shape.manifest }),
  z.strictObject({ status: z.literal("review"), operationId: ExecutionIdSchema, reviewId: ExecutionIdSchema, code: z.string(), evidenceKey: ObjectKeySchema, automaticRetry: z.literal(false) }),
]);
export type GncProductPrepareOutcome = z.infer<typeof GncProductPrepareOutcomeSchema>;
export const GncProductWorkflowInputSchema = z.strictObject({ input: GncProductInputSchema,
  queues: SavedProductWorkflowInputSchema.shape.queues });
export const GNC_PRODUCT_QUEUES = Object.freeze({ prepare: "v3.gnc.product-input.v1.gnc-input-v1", workflow: "v3.gnc.product.workflow.v1.gnc-product-v1",
  files: "v3.gnc.file.v1.gnc-file-v1", saved: "v3.product.saved.workflow.v1.saved-product-v3" });
