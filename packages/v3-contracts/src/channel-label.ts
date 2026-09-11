import { z } from "zod";
import { ChannelPlanInputSchema } from "./channel-plan.js";
import { ArtifactRefSchema, ExecutionIdSchema, Sha256Schema } from "./artifacts.js";
import { TextCompatibilitySchema } from "./text.js";
import { LabelProductManifestSchema, LabelProductSourceSchema, LabelEvidencePolicySchema } from "./label-product.js";
import { ResourceGateSchema } from "./resources.js";
import { SavedProductWorkflowInputSchema } from "./product-evidence.js";
export const ChannelLabelInputSchema = z.strictObject({ operationId: ExecutionIdSchema, sourcePlan: ChannelPlanInputSchema,
  text: TextCompatibilitySchema.refine(t => t.resultSchemaVersion === 3), visionConfigFingerprint: Sha256Schema,
  corePolicy:z.literal("swanson-label-core/1").optional(),
  evidencePolicy: LabelEvidencePolicySchema }).refine(i => ![i.sourcePlan.operationId, i.sourcePlan.source.producer.operationId].includes(i.operationId));
export type ChannelLabelInput = z.infer<typeof ChannelLabelInputSchema>;
export const ChannelLabelSourceRequestSchema = z.strictObject({ input: ChannelLabelInputSchema, sourceId: ExecutionIdSchema });
export const ChannelLabelSourceResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("prepared"), input: ChannelLabelSourceRequestSchema, source: LabelProductSourceSchema }),
  z.strictObject({ status: z.literal("not_matched"), input: ChannelLabelSourceRequestSchema }),
]);
export const ChannelLabelManifestResultSchema = z.strictObject({ input: ChannelLabelInputSchema, manifest: LabelProductManifestSchema, skipped: z.array(ExecutionIdSchema).max(100) });
export const ChannelLabelPlanResultSchema = z.strictObject({ input: ChannelLabelInputSchema, manifest: SavedProductWorkflowInputSchema.shape.manifest });
const queue=z.string().min(1).max(255);
export const ChannelSavedLabelWorkflowInputSchema=z.strictObject({input:ChannelLabelInputSchema,resources:ResourceGateSchema.optional(),
  queues:z.strictObject({plan:queue,page:queue,pageText:queue,imagePrepare:queue,ocr:queue,ocrReceipts:queue,keywords:queue,
    core:queue.optional(),source:queue,manifest:queue,text:queue,textReceipts:queue,vision:queue,assembly:queue,collection:queue,review:queue})}).refine(r=>!r.input.corePolicy||!!r.queues.core);
export const ChannelSourceReadySchema=z.strictObject({operationId:ExecutionIdSchema,sourceId:ExecutionIdSchema,file:ArtifactRefSchema});
export const ChannelStreamSealSchema=z.strictObject({operationId:ExecutionIdSchema,status:z.enum(["closed","failed"])});
