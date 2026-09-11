import { z } from "zod";
import { ExecutionIdSchema, ObservationSchema, ObjectKeySchema, Sha256Schema } from "./artifacts.js";
import { TextInputSchema, TextRecordSchema } from "./text.js";
import { VisionTaskSchema, VisionRecordSchema } from "./vision.js";
import { observationIdentity, OcrInputSchema } from "./processing.js";
import { PageTextPlanSchema } from "./page-handoff.js";
import { PdfTextPlanSchema } from "./pdf.js";
import { FileOcrPlanSchema } from "./acquisition.js";
const common = { id: ExecutionIdSchema, required: z.boolean() };
export const ProductResolvedEvidenceSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("text"), task: TextInputSchema.refine(t => t.resultSchemaVersion === 2 && t.source.kind === "prepared") }),
  z.strictObject({ ...common, kind: z.literal("image"), task: VisionTaskSchema }),
]);
export const SavedEvidenceSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("file-image"), plan: FileOcrPlanSchema, visionOperationId: ExecutionIdSchema, configFingerprint: Sha256Schema }),
  z.strictObject({ ...common, kind: z.literal("page"), plan: PageTextPlanSchema }),
  z.strictObject({ ...common, kind: z.literal("pdf-text"), plan: PdfTextPlanSchema }),
  z.strictObject({ ...common, kind: z.literal("ocr-image"), task: OcrInputSchema, visionOperationId: ExecutionIdSchema, configFingerprint: Sha256Schema }),
]);
export type SavedEvidenceSource = z.infer<typeof SavedEvidenceSourceSchema>;
export type ProductResolvedEvidenceSource = z.infer<typeof ProductResolvedEvidenceSourceSchema>;
export const ProductEvidenceSourceSchema = z.union([ProductResolvedEvidenceSourceSchema, SavedEvidenceSourceSchema]);
export const ProductEvidenceManifestSchema = z.strictObject({ operationId: ExecutionIdSchema, observation: ObservationSchema,
  sources: z.array(ProductEvidenceSourceSchema).min(1).max(100),
}).superRefine((m, ctx) => {
  const ids = new Set<string>(), ops = new Set<string>();
  for (const s of m.sources) {
    const owner = s.kind === "file-image" ? observationIdentity(s.plan.acquire) : s.kind === "pdf-text" ? observationIdentity(s.plan.extraction) : s.kind === "page" ? observationIdentity(s.plan.page) : s.kind === "image" ? s.task.input.selection.observation : observationIdentity(s.task);
    const ownOps = s.kind === "file-image" ? [s.plan.acquire.operationId, s.plan.ocrOperationId, s.visionOperationId] : s.kind === "pdf-text" ? [s.plan.extraction.operationId, s.plan.textOperationId] : s.kind === "page" ? [s.plan.page.operationId, s.plan.textOperationId] : s.kind === "ocr-image"
      ? [s.task.operationId, s.visionOperationId] : [s.kind === "text" ? s.task.operationId : s.task.input.operationId];
    if (ids.has(s.id) || new Set(ownOps).size !== ownOps.length || ownOps.some(op => ops.has(op) || op === m.operationId) || JSON.stringify(owner) !== JSON.stringify(m.observation))
      ctx.addIssue({ code: "custom", message: "Evidence owner or operation conflict" });
    ids.add(s.id); ownOps.forEach(op => ops.add(op));
  }
});
export type ProductEvidenceManifest = z.infer<typeof ProductEvidenceManifestSchema>;
export type ProductEvidenceSource = z.infer<typeof ProductEvidenceSourceSchema>;
export const ProductResolvedEvidenceManifestSchema = z.strictObject({ operationId: ExecutionIdSchema, observation: ObservationSchema,
  sources: z.array(ProductResolvedEvidenceSourceSchema).min(1).max(100),
}).superRefine((m, ctx) => { if (!ProductEvidenceManifestSchema.safeParse(m).success) ctx.addIssue({ code: "custom", message: "Evidence identity conflict" }); });
export const ProductEvidenceJoinSchema = z.strictObject({ manifest: ProductEvidenceManifestSchema,
  states: z.array(z.discriminatedUnion("status", [
    z.strictObject({ id: ExecutionIdSchema, status: z.literal("registered") }),
    z.strictObject({ id: ExecutionIdSchema, status: z.literal("unresolved") }),
    z.strictObject({ id: ExecutionIdSchema, status: z.literal("rejected") }),
    z.strictObject({ id: ExecutionIdSchema, status: z.literal("not_matched") }),
    z.strictObject({ id: ExecutionIdSchema, status: z.literal("review"), reviewId: ExecutionIdSchema }),
  ])).max(100),
});
export type ProductEvidenceJoin = z.infer<typeof ProductEvidenceJoinSchema>;
export const ProductCitationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), sourceId: ExecutionIdSchema, text: z.string().min(1).max(20000),
    start: z.number().int().nonnegative(), end: z.number().int().positive().max(200000) }).refine(r => r.end > r.start),
  z.strictObject({ kind: z.literal("image"), sourceId: ExecutionIdSchema, evidence: z.string().min(1).max(4000) }),
]);
export const ProductFieldSchema = z.strictObject({ text: z.string().min(1).max(20000), citations: z.array(ProductCitationSchema).min(1).max(100) });
export const ProductFormulaSchema = z.strictObject({ servingSize: ProductFieldSchema.nullable(), servingsPerContainer: ProductFieldSchema.nullable(),
  columns: z.array(z.strictObject({ heading: z.string().min(1).max(4000).nullable(), nutrients: z.array(z.strictObject({
    name: ProductFieldSchema, amount: ProductFieldSchema.nullable(), dailyValue: ProductFieldSchema.nullable(),
  })).min(1).max(200) })).min(1).max(8),
});
export const ProductIngredientSchema = z.strictObject({ name: ProductFieldSchema, role: z.enum(["other", "blend_component"]), parentBlend: z.string().nullable() });
export type ProductField = z.infer<typeof ProductFieldSchema>;
export type ProductFormula = z.infer<typeof ProductFormulaSchema>;
export type ProductIngredient = z.infer<typeof ProductIngredientSchema>;
export const MixedCollectionInputSchema = z.strictObject({ join: ProductEvidenceJoinSchema, evidenceKey: ObjectKeySchema });
export type MixedCollectionInput = z.infer<typeof MixedCollectionInputSchema>;
export const MixedCollectedProductSchema = z.strictObject({ schemaVersion: z.literal(2), codec: z.literal("collected-product/2"),
  operationId: ExecutionIdSchema, observation: ObservationSchema,
  assembly: z.strictObject({ objectKey: ObjectKeySchema, sha256: Sha256Schema, byteSize: z.number().int().positive().max(8388608) }),
  formula: ProductFormulaSchema, ingredients: z.array(ProductIngredientSchema).min(1).max(30000),
  warnings: z.array(z.strictObject({ id: ExecutionIdSchema, code: z.string().min(1).max(120) })).max(1000),
  provenance: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ id: ExecutionIdSchema, kind: z.literal("text"), record: TextRecordSchema }),
    z.strictObject({ id: ExecutionIdSchema, kind: z.literal("image"), record: VisionRecordSchema }),
  ])).min(1).max(100),
}).superRefine((r, ctx) => {
  const sources = new Map(r.provenance.map(p => [p.id, p.kind]));
  const invalid = () => ctx.addIssue({ code: "custom", message: "Mixed collected source conflict" });
  if (sources.size !== r.provenance.length) invalid();
  for (const p of r.provenance) {
    const owner = p.kind === "text" ? observationIdentity(p.record.input) : p.record.input.selection.observation;
    if (JSON.stringify(owner) !== JSON.stringify(r.observation)) invalid();
  }
  const fields = [r.formula.servingSize, r.formula.servingsPerContainer,
    ...r.formula.columns.flatMap(c => c.nutrients.flatMap(n => [n.name, n.amount, n.dailyValue])), ...r.ingredients.map(i => i.name)];
  for (const f of fields) for (const c of f?.citations ?? []) if (sources.get(c.sourceId) !== c.kind) invalid();
});
export type MixedCollectedProduct = z.infer<typeof MixedCollectedProductSchema>;
const queue = z.string().min(1).max(255);
export const MixedProductWorkflowInputSchema = z.strictObject({ manifest: ProductResolvedEvidenceManifestSchema,
  queues: z.strictObject({ text: queue, textReceipts: queue, vision: queue, assembly: queue, collection: queue }),
});
export type MixedProductWorkflowInput = z.infer<typeof MixedProductWorkflowInputSchema>;
export const SavedProductWorkflowInputSchema = z.strictObject({ manifest: z.strictObject({ operationId: ExecutionIdSchema, observation: ObservationSchema,
  sources: z.array(SavedEvidenceSourceSchema).min(1).max(100),
}).superRefine((m, ctx) => { if (!ProductEvidenceManifestSchema.safeParse(m).success) ctx.addIssue({ code: "custom", message: "Saved source identity conflict" }); }),
  queues: z.strictObject({ page: queue, pageText: queue, text: queue, textReceipts: queue, ocr: queue, ocrReceipts: queue,
    keywords: queue, vision: queue, assembly: queue, collection: queue, pdfText: queue.optional(), pdfTextPrepare: queue.optional(), acquire: queue.optional(), imagePrepare: queue.optional() }),
}).refine(i => !i.manifest.sources.some(s => s.kind === "pdf-text") || Boolean(i.queues.pdfText && i.queues.pdfTextPrepare), "PDF text queues required")
  .refine(i => !i.manifest.sources.some(s => s.kind === "file-image") || Boolean(i.queues.acquire && i.queues.imagePrepare), "File image queues required");
export type SavedProductWorkflowInput = z.infer<typeof SavedProductWorkflowInputSchema>;
