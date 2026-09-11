import { z } from "zod";
import { ArtifactRefSchema, ExecutionIdSchema, ObservationSchema, Sha256Schema, VersionTagSchema, assertArtifactBelongsTo } from "./artifacts.js";
import { ObjectKeySchema } from "./artifacts.js";
import { OcrInputSchema, ProcessingCompatibilitySchema, observationIdentity } from "./processing.js";
const operation = { ...ObservationSchema.shape, operationId: ExecutionIdSchema,
    implementationVersion: VersionTagSchema, policyVersion: VersionTagSchema, configFingerprint: Sha256Schema };
export const SourceBindingSchema = z.strictObject({ sessionId: ExecutionIdSchema, egressId: VersionTagSchema });
export type SourceBinding = z.infer<typeof SourceBindingSchema>;
export const FileAcquireInputSchema = z.strictObject({ ...operation, module: z.literal("file.acquire"),
    // Opaque locator owned by the original source session. No cookies/URLs/proxy config in task payloads.
    resourceId: ExecutionIdSchema, binding: SourceBindingSchema,
    expectedSha256: Sha256Schema.nullable(), inputFingerprint: Sha256Schema,
});
export type FileAcquireInput = z.infer<typeof FileAcquireInputSchema>;
export const AcquiredFileRecordSchema = z.strictObject({ schemaVersion: z.literal(1), codec: z.literal("acquired-file/1"),
    input: FileAcquireInputSchema, file: ArtifactRefSchema,
    dimensions: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable(),
    redirects: z.number().int().min(0).max(3),
}).superRefine((r, ctx) => {
    try { assertArtifactBelongsTo(r.file, observationIdentity(r.input)); } catch { ctx.addIssue({ code: "custom", message: "Acquired file owner conflict" }); }
    if (!["source-image", "source-pdf"].includes(r.file.kind) || r.file.producer.operationId !== r.input.operationId ||
      r.file.producer.module !== "file.acquire" || r.file.producer.implementationVersion !== r.input.implementationVersion)
      ctx.addIssue({ code: "custom", message: "Acquired file producer conflict" });
});
export type AcquiredFileRecord = z.infer<typeof AcquiredFileRecordSchema>;
export const AcquisitionReviewSchema = z.strictObject({ status: z.literal("review"), operationId: ExecutionIdSchema,
    reviewId: ExecutionIdSchema, code: z.string().regex(/^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/), evidenceKey: ObjectKeySchema, automaticRetry: z.literal(false) });
export const FileAcquireOutcomeSchema = z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("durable"), operationId: ExecutionIdSchema, file: ArtifactRefSchema, evidenceKey: ObjectKeySchema }), AcquisitionReviewSchema,
]);
export type FileAcquireOutcome = z.infer<typeof FileAcquireOutcomeSchema>;
export const FileOcrPlanSchema = z.strictObject({ imageId: ExecutionIdSchema, acquire: FileAcquireInputSchema,
    ocrOperationId: ExecutionIdSchema, ocr: ProcessingCompatibilitySchema.refine(c => c.resultSchemaVersion === 2) });
export type FileOcrPlan = z.infer<typeof FileOcrPlanSchema>;
export const ImageOcrPrepareInputSchema = z.strictObject({ plan: FileOcrPlanSchema, receipt: FileAcquireOutcomeSchema.nullable() });
export type ImageOcrPrepareInput = z.infer<typeof ImageOcrPrepareInputSchema>;
export const ImageOcrPrepareOutcomeSchema = z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("prepared"), task: OcrInputSchema, evidenceKey: ObjectKeySchema }), AcquisitionReviewSchema,
]);
export type ImageOcrPrepareOutcome = z.infer<typeof ImageOcrPrepareOutcomeSchema>;
export const PagePrepareInputSchema = z.strictObject({ ...operation, module: z.literal("page.prepare"),
    page: ArtifactRefSchema.refine(ref => ref.kind === "source-html", "One captured HTML artifact required"), inputFingerprint: Sha256Schema,
}).refine(input => {
    try {
        assertArtifactBelongsTo(input.page, { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId,
            brandId: input.brandId, sourceId: input.sourceId, listingId: input.listingId, variantId: input.variantId });
        return true;
    }
    catch {
        return false;
    }
}, "Page ownership mismatch");
export type PagePrepareInput = z.infer<typeof PagePrepareInputSchema>;
export function acquisitionFingerprintMaterial(input: FileAcquireInput | PagePrepareInput): string {
    const common = ["v3:acquisition:1", input.schemaVersion, input.requestId, input.observationId, input.operationId,
        input.brandId, input.sourceId, input.listingId, input.variantId, input.module, input.implementationVersion, input.policyVersion, input.configFingerprint];
    return JSON.stringify(input.module === "file.acquire" ? [...common, input.resourceId, input.binding.sessionId, input.binding.egressId, input.expectedSha256] :
        [...common, input.page.artifactId, input.page.sha256, input.page.byteSize, input.page.producer.operationId, input.page.producer.module, input.page.producer.implementationVersion]);
}
