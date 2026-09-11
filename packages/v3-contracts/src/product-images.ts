import { z } from "zod";
import { ExecutionIdSchema, ObservationSchema, ObjectKeySchema, Sha256Schema, ArtifactRefSchema, assertArtifactBelongsTo } from "./artifacts.js";
import { KeywordReceiptSchema, VisionTaskSchema, VisionCandidateSchema, ImageEvidenceSchema } from "./vision.js";
import { OcrInputSchema, observationIdentity } from "./processing.js";
import { OcrActivityOutcomeSchema } from "./ocr-execution.js";
import { OcrRegistrationSchema } from "./registration.js";
import { FileOcrPlanSchema } from "./acquisition.js";
import { PdfPageOcrPlanSchema, PdfProductPlanSchema } from "./pdf.js";
export const ProductImageManifestSchema = z.strictObject({ operationId: ExecutionIdSchema.refine(s => s.length <= 80),
  observation: ObservationSchema, imageIds: z.array(ExecutionIdSchema).max(100).refine(ids => new Set(ids).size === ids.length),
  configFingerprint: Sha256Schema });
export type ProductImageManifest = z.infer<typeof ProductImageManifestSchema>;
const queue = z.string().min(1).max(255);
export const ProductImageWorkflowInputSchema = z.strictObject({ manifest: ProductImageManifestSchema,
  queues: z.strictObject({ keywords: queue, vision: queue, assembly: queue, collection: queue, ocr: queue.optional(), receipts: queue.optional(), acquire: queue.optional(), prepare: queue.optional(), pdfRender:queue.optional(), pdfPrepare:queue.optional() }),
  initialOcr: z.array(OcrRegistrationSchema).max(100).default([]),
  ocrTasks: z.array(OcrInputSchema).max(100).optional(),
  fileTasks: z.array(FileOcrPlanSchema).max(100).optional(),
  pdfTasks: z.array(PdfPageOcrPlanSchema).min(1).max(100).optional(),
  ocrWaitMs: z.number().int().min(1000).max(3600000).default(3600000),
}).superRefine((r, ctx) => {
  if(r.pdfTasks!==undefined){
    if(r.fileTasks!==undefined || r.ocrTasks!==undefined || r.initialOcr.length || r.queues.acquire || r.queues.prepare || !r.queues.pdfRender || !r.queues.pdfPrepare || !r.queues.ocr || !r.queues.receipts)
      ctx.addIssue({code:"custom",message:"PDF mode requires dedicated queues and cannot mix modes"});
    const ids=new Set<string>(),ops=new Set<string>();
    for(const p of r.pdfTasks){
      if(ids.has(p.imageId)||!r.manifest.imageIds.includes(p.imageId)||ops.has(p.render.operationId)||ops.has(p.ocrOperationId)||
        JSON.stringify(observationIdentity(p.render))!==JSON.stringify(r.manifest.observation))ctx.addIssue({code:"custom",message:"PDF page identity conflict"});
      ids.add(p.imageId);ops.add(p.render.operationId);ops.add(p.ocrOperationId);
    }
    if(ids.size!==r.manifest.imageIds.length)ctx.addIssue({code:"custom",message:"Complete PDF page manifest required"});
    return;
  }
  if(r.queues.pdfRender||r.queues.pdfPrepare)ctx.addIssue({code:"custom",message:"PDF queues require PDF tasks"});
  if (r.fileTasks !== undefined) {
    if (r.ocrTasks !== undefined || r.initialOcr.length || !r.queues.ocr || !r.queues.receipts || !r.queues.acquire || !r.queues.prepare)
      ctx.addIssue({ code: "custom", message: "File mode requires its own queues and cannot mix input modes" });
    const images = new Set<string>(), ops = new Set<string>();
    for (const p of r.fileTasks) {
      if (images.has(p.imageId) || !r.manifest.imageIds.includes(p.imageId) || ops.has(p.acquire.operationId) || ops.has(p.ocrOperationId) ||
        p.acquire.operationId === p.ocrOperationId || JSON.stringify(observationIdentity(p.acquire)) !== JSON.stringify(r.manifest.observation))
        ctx.addIssue({ code: "custom", message: "File task identity/operation conflict" });
      images.add(p.imageId); ops.add(p.acquire.operationId); ops.add(p.ocrOperationId);
    }
    if (images.size !== r.manifest.imageIds.length) ctx.addIssue({ code: "custom", message: "Complete file task manifest required" });
    return;
  }
  if (r.queues.acquire || r.queues.prepare) ctx.addIssue({ code: "custom", message: "Acquisition queues require file tasks" });
  if (r.ocrTasks === undefined) {
    if (r.queues.ocr || r.queues.receipts) ctx.addIssue({ code: "custom", message: "OCR queues require owned OCR tasks" });
    return;
  }
  if (r.initialOcr.length || !r.queues.ocr || !r.queues.receipts)
    ctx.addIssue({ code: "custom", message: "Owned OCR and external receipt modes cannot be mixed" });
  const ids = new Set<string>(), operations = new Set<string>();
  for (const task of r.ocrTasks) {
    if (ids.has(task.file.artifactId) || operations.has(task.operationId) || !r.manifest.imageIds.includes(task.file.artifactId) ||
      JSON.stringify(observationIdentity(task)) !== JSON.stringify(r.manifest.observation) || task.resultSchemaVersion !== 2 ||
      !["source-image", "pdf-page"].includes(task.file.kind))
      ctx.addIssue({ code: "custom", message: "OCR task manifest/identity/version conflict" });
    ids.add(task.file.artifactId); operations.add(task.operationId);
  }
  if (ids.size !== r.manifest.imageIds.length) ctx.addIssue({ code: "custom", message: "Complete OCR task manifest required" });
});
export type ProductImageWorkflowInput = z.infer<typeof ProductImageWorkflowInputSchema>;
export const ProductPdfWorkflowInputSchema=z.strictObject({plan:PdfProductPlanSchema,queues:z.strictObject({
  inspection:queue,pages:queue,pdfRender:queue,pdfPrepare:queue,ocr:queue,receipts:queue,keywords:queue,vision:queue,assembly:queue,collection:queue,
})});
export const OcrReceiptInputSchema = z.strictObject({ input: OcrInputSchema, outcome: OcrActivityOutcomeSchema.nullable() });
export type OcrReceiptInput = z.infer<typeof OcrReceiptInputSchema>;
export const OcrReceiptOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("registered"), registration: OcrRegistrationSchema }),
  z.strictObject({ status: z.literal("review"), operationId: ExecutionIdSchema, imageId: ExecutionIdSchema,
    reviewId: ExecutionIdSchema, code: z.string().regex(/^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/), automaticRetry: z.literal(false) }),
]);
export type OcrReceiptOutcome = z.infer<typeof OcrReceiptOutcomeSchema>;
export const ProductImageStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_matched"), imageId: ExecutionIdSchema, keyword: KeywordReceiptSchema }),
  z.strictObject({ status: z.literal("registered"), imageId: ExecutionIdSchema, keyword: KeywordReceiptSchema, task: VisionTaskSchema }),
  z.strictObject({ status: z.literal("review"), imageId: ExecutionIdSchema, code: z.string().regex(/^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/), reviewId: ExecutionIdSchema.nullable() }),
]);
export type ProductImageState = z.infer<typeof ProductImageStateSchema>;
export const ProductImageJoinSchema = z.strictObject({ manifest: ProductImageManifestSchema, images: z.array(ProductImageStateSchema).max(100) });
export type ProductImageJoin = z.infer<typeof ProductImageJoinSchema>;
export const ProductImageOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), evidenceKey: ObjectKeySchema }),
  z.strictObject({ status: z.literal("review"), evidenceKey: ObjectKeySchema, reviewId: ExecutionIdSchema,
    codes: z.array(z.string()).min(1), automaticRetry: z.literal(false) }),
]);
export type ProductImageOutcome = z.infer<typeof ProductImageOutcomeSchema>;
export const ProductCollectionInputSchema = z.strictObject({ join: ProductImageJoinSchema, evidenceKey: ObjectKeySchema });
export type ProductCollectionInput = z.infer<typeof ProductCollectionInputSchema>;
export const CollectedProductSchema = z.strictObject({ schemaVersion: z.literal(1), codec: z.literal("collected-product/1"),
  operationId: ExecutionIdSchema, observation: ObservationSchema,
  assembly: z.strictObject({ objectKey: ObjectKeySchema, sha256: Sha256Schema, byteSize: z.number().int().positive().max(8388608) }),
  formula: VisionCandidateSchema.shape.formula.unwrap(), ingredients: VisionCandidateSchema.shape.ingredients.min(1),
  provenance: z.array(z.strictObject({ image: ImageEvidenceSchema, result: ArtifactRefSchema })).min(1).max(100),
}).superRefine((r, ctx) => {
  for (const p of r.provenance) for (const ref of [p.image, p.result]) {
    try { assertArtifactBelongsTo(ref, r.observation); } catch { ctx.addIssue({ code: "custom", message: "Collected product source conflict" }); }
  }
});
export type CollectedProduct = z.infer<typeof CollectedProductSchema>;
export const ProductSavedReceiptSchema = z.strictObject({ status: z.literal("collected"), operationId: ExecutionIdSchema,
  observationId: ExecutionIdSchema, evidenceKey: ObjectKeySchema, recordHash: Sha256Schema });
export const ProductWorkflowOutcomeSchema = z.union([ProductSavedReceiptSchema, ProductImageOutcomeSchema.options[1]]);
export type ProductWorkflowOutcome = z.infer<typeof ProductWorkflowOutcomeSchema>;
