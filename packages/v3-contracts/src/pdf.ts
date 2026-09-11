import {z} from "zod";
import {ArtifactRefSchema,ObservationSchema,ExecutionIdSchema,Sha256Schema,VersionTagSchema,ObjectKeySchema,assertArtifactBelongsTo} from "./artifacts.js";
import { ProcessingCompatibilitySchema, OcrInputSchema } from "./processing.js";
import { TextCompatibilitySchema, TextInputSchema } from "./text.js";
const fields={...ObservationSchema.shape,operationId:ExecutionIdSchema,implementationVersion:VersionTagSchema,policyVersion:VersionTagSchema,
  configFingerprint:Sha256Schema,inputFingerprint:Sha256Schema,pdf:ArtifactRefSchema.refine(f=>f.kind==="source-pdf","One source PDF required")};
export const PdfInputSchema=z.discriminatedUnion("module",[
  z.strictObject({...fields,module:z.literal("pdf.inspect")}),
  z.strictObject({...fields,module:z.literal("pdf.text"),pageIndex:z.number().int().min(0).max(499)}),
  z.strictObject({...fields,module:z.literal("pdf.render"),pageIndex:z.number().int().min(0).max(499),scale:z.number().min(0.25).max(4)}),
]).refine(input=>{
  try{assertArtifactBelongsTo(input.pdf,{schemaVersion:1,requestId:input.requestId,observationId:input.observationId,brandId:input.brandId,sourceId:input.sourceId,listingId:input.listingId,variantId:input.variantId});return true;}catch{return false;}
},"PDF ownership mismatch");
export type PdfInput=z.infer<typeof PdfInputSchema>;
export function pdfFingerprintMaterial(i:PdfInput):string {
  return JSON.stringify(["v3:pdf:1",i.schemaVersion,i.requestId,i.observationId,i.operationId,i.brandId,i.sourceId,i.listingId,i.variantId,
    i.module,i.implementationVersion,i.policyVersion,i.configFingerprint,i.pdf.artifactId,i.pdf.sha256,i.pdf.byteSize,
    i.pdf.producer.operationId,i.pdf.producer.module,i.pdf.producer.implementationVersion,
    i.module==="pdf.inspect"?null:i.pageIndex,i.module==="pdf.render"?i.scale:null]);
}
export const PdfCodeSchema=z.enum(["PDF.INVALID_INPUT","PDF.INPUT_INTEGRITY","PDF.BAD_FILE","PDF.ENCRYPTED","PDF.PAGE_LIMIT","PDF.PAGE_RANGE",
  "PDF.DIMENSIONS","PDF.TEXT_LIMIT","PDF.OUTPUT_LIMIT","PDF.ENGINE_MISMATCH","PDF.RESOURCE_LIMIT","PDF.PROCESS_FAILED","PDF.TIMEOUT","PDF.CANCELLED",
  "PDF.PROTOCOL","PDF.RESULT_INTEGRITY","PDF.ATTEMPT_MISSING"]);
export type PdfCode=z.infer<typeof PdfCodeSchema>;
export const PdfGeometrySchema=z.strictObject({pageIndex:z.number().int().min(0).max(499),widthPoints:z.number().positive().max(14400),heightPoints:z.number().positive().max(14400)});
export const PdfDataSchema=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("inspect"),pageCount:z.number().int().min(1).max(500),pages:z.array(PdfGeometrySchema).min(1).max(500)}),
  z.strictObject({kind:z.literal("text"),pageIndex:z.number().int().min(0).max(499),text:z.string().max(1000000),hasText:z.boolean()}),
]);
export type PdfData=z.infer<typeof PdfDataSchema>;
export const PdfManifestSchema=z.strictObject({protocolVersion:z.literal(1),operationId:ExecutionIdSchema,inputFingerprint:Sha256Schema,sourceSha256:Sha256Schema,
  module:z.enum(["pdf.inspect","pdf.text","pdf.render"]),pageIndex:z.number().int().min(0).max(499).nullable(),scale:z.number().min(0.25).max(4).nullable(),
  filename:z.enum(["output.json","output.png"]),sha256:Sha256Schema,byteSize:z.number().int().positive().max(33554432),
  width:z.number().int().positive().max(10000).nullable(),height:z.number().int().positive().max(10000).nullable(),
  engine:z.strictObject({pypdfium2:z.string().min(1).max(60),pdfium:z.string().min(1).max(60),pillow:z.string().min(1).max(60)}),
  process:z.strictObject({pid:z.number().int().positive(),platform:z.string().min(1).max(40),hardAddressSpaceLimit:z.boolean(),cpuLimit:z.boolean()}),
  complete:z.literal(true),
});
export type PdfManifest=z.infer<typeof PdfManifestSchema>;
/** Immutable shared-store receipt. Does not claim processing_result registration. */
export const PdfCompletionSchema=z.strictObject({schemaVersion:z.literal(1),codec:z.literal("pdf-completion/1"),
  input:PdfInputSchema,manifest:PdfManifestSchema,artifact:ArtifactRefSchema});
export type PdfCompletion=z.infer<typeof PdfCompletionSchema>;
export const PdfActivityOutcomeSchema=z.discriminatedUnion("status",[
  z.strictObject({status:z.literal("durable"),operationId:ExecutionIdSchema,artifact:ArtifactRefSchema,evidenceKey:ObjectKeySchema}),
  z.strictObject({status:z.literal("review"),operationId:ExecutionIdSchema,reviewId:ExecutionIdSchema,evidenceKey:ObjectKeySchema,
    code:z.string().regex(/^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/),automaticRetry:z.literal(false)}),
]);
export type PdfActivityOutcome=z.infer<typeof PdfActivityOutcomeSchema>;
export const PdfProductPlanSchema=z.strictObject({operationId:ExecutionIdSchema.refine(s=>s.length<=60),
  inspection:PdfInputSchema.refine(i=>i.module==="pdf.inspect"),scale:z.number().min(0.25).max(4),
  ocr:ProcessingCompatibilitySchema.refine(c=>c.resultSchemaVersion===2),configFingerprint:Sha256Schema});
export type PdfProductPlan=z.infer<typeof PdfProductPlanSchema>;
export const PdfPageOcrPlanSchema=z.strictObject({imageId:ExecutionIdSchema,render:PdfInputSchema.refine(i=>i.module==="pdf.render"),
  ocrOperationId:ExecutionIdSchema,ocr:ProcessingCompatibilitySchema.refine(c=>c.resultSchemaVersion===2)
}).refine(p=>p.imageId===`pdf-${p.render.inputFingerprint}` && p.ocrOperationId!==p.render.operationId);
export type PdfPageOcrPlan=z.infer<typeof PdfPageOcrPlanSchema>;
export const PdfPagesPrepareInputSchema=z.strictObject({plan:PdfProductPlanSchema,receipt:PdfActivityOutcomeSchema.nullable()});
export type PdfPagesPrepareInput=z.infer<typeof PdfPagesPrepareInputSchema>;
export const PdfPagesPrepareOutcomeSchema=z.discriminatedUnion("status",[
  z.strictObject({status:z.literal("planned"),pages:z.array(PdfPageOcrPlanSchema).min(1).max(100),evidenceKey:ObjectKeySchema}),
  PdfActivityOutcomeSchema.options[1],
]);
export const PdfOcrPrepareInputSchema=z.strictObject({plan:PdfPageOcrPlanSchema,receipt:PdfActivityOutcomeSchema.nullable()});
export type PdfOcrPrepareInput=z.infer<typeof PdfOcrPrepareInputSchema>;
export const PdfOcrPrepareOutcomeSchema=z.discriminatedUnion("status",[
  z.strictObject({status:z.literal("prepared"),task:OcrInputSchema,evidenceKey:ObjectKeySchema}),PdfActivityOutcomeSchema.options[1],
]);
/** One explicit PDF page. Choosing pages or image/text routing belongs to the parent. */
export const PdfTextPlanSchema = z.strictObject({
  extraction: PdfInputSchema.refine(i => i.module === "pdf.text"),
  textOperationId: ExecutionIdSchema,
  text: TextCompatibilitySchema.refine(c => c.resultSchemaVersion === 2),
}).refine(p => new Set([p.extraction.operationId, p.textOperationId, p.extraction.pdf.producer.operationId]).size === 3,
  "Independent operations required");
export type PdfTextPlan = z.infer<typeof PdfTextPlanSchema>;
export const PdfTextPrepareInputSchema = z.strictObject({ plan: PdfTextPlanSchema, receipt: PdfActivityOutcomeSchema.nullable() });
export type PdfTextPrepareInput = z.infer<typeof PdfTextPrepareInputSchema>;
export const PdfTextPrepareOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("prepared"), task: TextInputSchema, evidenceKey: ObjectKeySchema }),
  PdfActivityOutcomeSchema.options[1],
]);
export const PdfTextWorkflowInputSchema = z.strictObject({ plan: PdfTextPlanSchema,
  queues: z.strictObject({ extraction: z.string().min(1).max(255), prepare: z.string().min(1).max(255),
    text: z.string().min(1).max(255), receipts: z.string().min(1).max(255) }),
});
