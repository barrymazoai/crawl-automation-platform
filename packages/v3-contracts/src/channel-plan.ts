import { z } from "zod";
import { ArtifactRefSchema, ExecutionIdSchema, ObservationSchema, Sha256Schema, ObjectKeySchema, assertArtifactBelongsTo } from "./artifacts.js";
import { TextCompatibilitySchema } from "./text.js";
import { ProcessingCompatibilitySchema } from "./processing.js";
import { SourceBindingSchema, AcquisitionReviewSchema } from "./acquisition.js";
import { SavedProductWorkflowInputSchema } from "./product-evidence.js";
import { ChannelProductEvidenceSchema } from "./channel-evidence.js";

export const ChannelPlanInputSchema = z.strictObject({
  operationId: ExecutionIdSchema, owner: ObservationSchema, channel: z.enum(["swanson", "amazon", "dtc"]),
  parserVersion: z.enum(["swanson-rendered/1", "amazon-rendered/1", "dtc-rendered/1"]), expectedUrl: z.string().url().max(4096), source: ArtifactRefSchema,
  binding: SourceBindingSchema, text: TextCompatibilitySchema.refine(c => c.resultSchemaVersion === 2),
  ocr: ProcessingCompatibilitySchema.refine(c => c.resultSchemaVersion === 2), visionConfigFingerprint: Sha256Schema,
}).superRefine((i, ctx) => {
  try { assertArtifactBelongsTo(i.source, i.owner); } catch { ctx.addIssue({ code: "custom", message: "Source owner conflict" }); }
  // A projection comes from an owned browser page or, for Amazon, from one static HTTP fetch through a provider route.
  if (i.source.kind !== "result-json" || ![`${i.channel}.browser-projection`, ...(i.channel === "amazon" ? ["amazon.http-projection"] : [])].includes(i.source.producer.module) ||
    i.source.producer.implementationVersion !== i.parserVersion || i.parserVersion !== `${i.channel}-rendered/1` || i.source.producer.operationId === i.operationId || (i.channel === "swanson" ? i.owner.variantId === null : i.owner.variantId !== null))
    ctx.addIssue({ code: "custom", message: "Rendered source provenance required" });
});
export type ChannelPlanInput = z.infer<typeof ChannelPlanInputSchema>;
export const ChannelProductPlanSchema = z.strictObject({ codec: z.literal("channel-plan/1"), input: ChannelPlanInputSchema,
  product: ChannelProductEvidenceSchema, fragment: ArtifactRefSchema.nullable(), manifest: SavedProductWorkflowInputSchema.shape.manifest,
  // Retained private-side plan only. Temporal outcome contains opaque resource IDs, not provider URLs.
  files: z.array(z.strictObject({ resourceId: ExecutionIdSchema, url: z.string().url().max(4096) })).max(100),
});
export type ChannelProductPlan = z.infer<typeof ChannelProductPlanSchema>;
export const ChannelPlanOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("prepared"), operationId: ExecutionIdSchema, inputFingerprint: Sha256Schema,
    evidenceKey: ObjectKeySchema, manifest: SavedProductWorkflowInputSchema.shape.manifest }), AcquisitionReviewSchema,
]);
export type ChannelPlanOutcome = z.infer<typeof ChannelPlanOutcomeSchema>;
