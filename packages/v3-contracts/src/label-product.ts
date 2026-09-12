import { z } from "zod";
import { assertArtifactBelongsTo, ArtifactRefSchema, ExecutionIdSchema, ObservationSchema, ObjectKeySchema, Sha256Schema } from "./artifacts.js";
import { PackagingFactsSchema } from "./packaging.js";
import { TextInputSchema, TextRecordSchema, TextCandidateV3Schema } from "./text.js";
import { VisionTaskSchema, VisionRecordSchema } from "./vision.js";
import { observationIdentity } from "./processing.js";
import { labelExtractionSchema, LabelImageCandidateSchema, assessLabelCandidate, type LabelImageCandidate } from "./label-extraction.js";
import type { TextCandidateV3 } from "./text.js";
import { ProductEvidenceJoinSchema } from "./product-evidence.js";
import { labelTypographyStructure, labelNameForComparison } from "./label-typography.js";
import { labelFormulaStructure } from "./label-extraction.js";
import { labelImageIntegrityCodes, labelNumericSourceConflict } from "./label-quality.js";
export const LabelEvidencePolicySchema = z.enum(["label-image-first/1", "label-image-first/2", "label-image-first/3", "label-image-first/4", "label-image-first/5"]);
/** Priority is earned by a complete, structurally valid image, never merely its media type. */
export function isCompleteLabelImage(p: { kind: string; candidate: LabelImageCandidate | TextCandidateV3 }) {
  return p.kind === "image" && p.candidate.formulaComplete && p.candidate.ingredientsComplete && assessLabelCandidate(p.candidate).status === "candidate";
}
export function isCompleteLabelText(p: { kind: string; candidate: LabelImageCandidate | TextCandidateV3 }) {
  return p.kind === "text" && p.candidate.formulaComplete && p.candidate.ingredientsComplete && assessLabelCandidate(p.candidate).status === "candidate";
}
const common = { id: ExecutionIdSchema, required: z.boolean() };
export const LabelProductSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("text"), task: TextInputSchema.refine(t => t.resultSchemaVersion === 3 && t.source.kind === "prepared") }),
  z.strictObject({ ...common, kind: z.literal("image"), task: VisionTaskSchema.refine(t => !!t.input.extractionProtocol) }),
]);
export const LabelProductManifestSchema = z.strictObject({ operationId: ExecutionIdSchema, observation: ObservationSchema,
  evidencePolicy: LabelEvidencePolicySchema.optional(),
  admission: z.strictObject({ policy: z.literal("label-packaging/1"), comparison: z.enum(["label-typography/1", "label-typography/2"]).optional(), documents: z.array(ArtifactRefSchema).min(1).max(100) }).optional(),
  sources: z.array(LabelProductSourceSchema).min(1).max(100) }).superRefine((m, ctx) => {
  const ids = new Set<string>(), ops = new Set<string>();
  const documents = new Set<string>();
  for (const ref of m.admission?.documents ?? []) {
    try { assertArtifactBelongsTo(ref, m.observation); } catch { ctx.addIssue({ code: "custom", message: "Packaging source identity conflict" }); }
    if (documents.has(ref.objectKey) || ref.kind !== "result-json" || !["page.prepare", "pdf.text"].includes(ref.producer.module))
      ctx.addIssue({ code: "custom", message: "Invalid packaging document" });
    documents.add(ref.objectKey);
  }
  for (const s of m.sources) {
    const op = s.kind === "text" ? s.task.operationId : s.task.input.operationId;
    const owner = s.kind === "text" ? observationIdentity(s.task) : s.task.input.selection.observation;
    if (ids.has(s.id) || ops.has(op) || op === m.operationId || JSON.stringify(owner) !== JSON.stringify(m.observation))
      ctx.addIssue({ code: "custom", message: "Label source identity conflict" });
    ids.add(s.id); ops.add(op);
  }
});
export const LabelProductJoinSchema = z.strictObject({ manifest: LabelProductManifestSchema, states: ProductEvidenceJoinSchema.shape.states });
export type LabelProductManifest = z.infer<typeof LabelProductManifestSchema>;
export type LabelProductJoin = z.infer<typeof LabelProductJoinSchema>;
export const LabelProductFieldSchema = z.strictObject({ text: z.string().min(1).max(20000), sourceId: ExecutionIdSchema,
  citation: z.union([z.strictObject({ kind: z.literal("text"), start: z.number().int().nonnegative(), end: z.number().int().positive().max(200000) }),
    z.strictObject({ kind: z.literal("image"), evidence: z.string().min(1).max(20000) })]) });
const projected = labelExtractionSchema(LabelProductFieldSchema);
export const LabelProductFormulaSchema = projected.shape.formula.unwrap();
export const LabelProductOtherSchema = projected.shape.otherIngredients;
export const LabelProductIngredientSchema = z.strictObject({ name: LabelProductFieldSchema,
  role: z.enum(["blend_component", "other"]), amount: LabelProductFieldSchema.nullable(),
  columnIndex: z.number().int().nonnegative().nullable(), rowIndex: z.number().int().nonnegative().nullable(),
  parentRowIndex: z.number().int().nonnegative().nullable() });
export const LabelProductProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: ExecutionIdSchema, kind: z.literal("text"), record: TextRecordSchema, candidate: TextCandidateV3Schema }),
  z.strictObject({ id: ExecutionIdSchema, kind: z.literal("image"), record: VisionRecordSchema, candidate: LabelImageCandidateSchema }),
]);
/** Lossless field projection shared by merge and persisted-record validation. */
export function projectLabelProductCandidate(sourceId: string, c: LabelImageCandidate | TextCandidateV3) {
  const field = (f: NonNullable<typeof c.formula>["servingSize"]) => f ? { text: f.text, sourceId,
    citation: "evidence" in f ? { kind: "image" as const, evidence: f.evidence } : { kind: "text" as const, start: f.start, end: f.end } } : null;
  return { formula: c.formula ? LabelProductFormulaSchema.parse({ servingSize: field(c.formula.servingSize), servingsPerContainer: field(c.formula.servingsPerContainer),
    columns: c.formula.columns.map(col => ({ heading: field(col.heading), rows: col.rows.map(row => ({ ...row,
      name: field(row.name), amount: field(row.amount), dailyValue: field(row.dailyValue) })) })) }) : null,
    otherIngredients: c.otherIngredients ? LabelProductOtherSchema.parse({ heading: field(c.otherIngredients.heading), items: c.otherIngredients.items.map(field) }) : null };
}
const collectedFields = {
  evidencePolicy: LabelEvidencePolicySchema.optional(),
  operationId: ExecutionIdSchema, observation: ObservationSchema,
  assembly: z.strictObject({ objectKey: ObjectKeySchema, sha256: Sha256Schema, byteSize: z.number().int().positive().max(8388608) }),
  formula: LabelProductFormulaSchema, otherIngredients: LabelProductOtherSchema,
  ingredients: z.array(LabelProductIngredientSchema).min(1).max(1900),
  warnings: z.array(z.strictObject({ id: ExecutionIdSchema, code: z.string().min(1).max(160) })).max(1000),
  provenance: z.array(LabelProductProvenanceSchema).min(1).max(100),
};
export const LabelCollectedProductSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({ schemaVersion: z.literal(3), codec: z.literal("collected-product/3"), ...collectedFields }),
  z.strictObject({ schemaVersion: z.literal(4), codec: z.literal("collected-product/4"), ...collectedFields,
    admissionPolicy: z.literal("label-packaging/1"), comparisonPolicy: z.enum(["label-typography/1", "label-typography/2"]).optional(), packaging: PackagingFactsSchema }),
]).superRefine((r, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Label collected identity conflict" });
  const sources = new Map(r.provenance.map(p => [p.id, p]));
  if (sources.size !== r.provenance.length) invalid();
  for (const p of r.provenance) {
    const owner = p.kind === "text" ? observationIdentity(p.record.input) : p.record.input.selection.observation;
    if (JSON.stringify(owner) !== JSON.stringify(r.observation) || (p.kind === "text" ? p.record.input.resultSchemaVersion !== 3 : !p.record.input.extractionProtocol)) invalid();
  }
  const fields = [r.formula.servingSize, r.formula.servingsPerContainer,
    ...r.formula.columns.flatMap(c => [c.heading, ...c.rows.flatMap(row => [row.name, row.amount, row.dailyValue])]),
    ...(r.otherIngredients ? [r.otherIngredients.heading, ...r.otherIngredients.items] : []), ...r.ingredients.flatMap(i => [i.name, i.amount])];
  for (const f of fields) if (f && sources.get(f.sourceId)?.kind !== f.citation.kind) invalid();
  const quality = ["label-image-first/4", "label-image-first/5"].includes(r.evidencePolicy??"");
  const accepted = r.provenance.filter(p => assessLabelCandidate(p.candidate).status !== "review" && !(quality && p.kind === "image" && labelImageIntegrityCodes(p.candidate).length));
  if (r.evidencePolicy === "label-image-first/4" && labelNumericSourceConflict(accepted)) invalid();
  const imageFirst = !!r.evidencePolicy && accepted.some(isCompleteLabelImage);
  const textFallback = ["label-image-first/3","label-image-first/4", "label-image-first/5"].includes(r.evidencePolicy??"") && !imageFirst && accepted.some(isCompleteLabelText);
  const authoritative = accepted.filter(p => imageFirst ? p.kind === "image" : !textFallback || p.kind === "text");
  if(textFallback && !r.warnings.some(w=>w.code==="LABEL_PRODUCT.COMPLETE_TEXT_FALLBACK"))invalid();
  if(r.evidencePolicy==="label-image-first/5" && imageFirst && authoritative.length!==1)invalid();
  const projectedSources = authoritative.map(p => projectLabelProductCandidate(p.id, p.candidate));
  if (imageFirst) {
    // A forged persisted record cannot switch back to text or hide disagreeing images.
    const comparison = r.schemaVersion === 4 ? r.comparisonPolicy : undefined;
    const formulaShape = (candidate: LabelImageCandidate | TextCandidateV3) => {
      const shape = (comparison ? labelTypographyStructure(candidate, comparison) : labelFormulaStructure(candidate))!;
      if (r.schemaVersion === 4) shape.servingsPerContainer = null;
      return JSON.stringify(shape);
    };
    const otherShape = (candidate: LabelImageCandidate | TextCandidateV3) => JSON.stringify(candidate.otherIngredients!.items.map(i => comparison ? labelNameForComparison(i.text) : i.text.replace(/\s+/gu, " ").trim()));
    const formulas = authoritative.filter(p => p.candidate.formula).map(p => formulaShape(p.candidate));
    const others = authoritative.filter(p => p.candidate.otherIngredients).map(p => otherShape(p.candidate));
    if (new Set(formulas).size > 1 || new Set(others).size > 1) invalid();
    const requireWarning = (id: string, code: string) => { if (!r.warnings.some(w => w.id === id && w.code === code)) invalid(); };
    for (const p of accepted) {
      if (p.kind === "text" && p.candidate.formula && formulaShape(p.candidate) !== formulas[0]) requireWarning(p.id, "LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT");
      if (p.kind === "text" && p.candidate.otherIngredients && otherShape(p.candidate) !== others[0]) requireWarning(p.id, "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT");
      if (r.schemaVersion === 4 && r.packaging.servingSize.value && p.candidate.formula) {
        const shape = comparison ? labelTypographyStructure(p.candidate, comparison) : labelFormulaStructure(p.candidate);
        if (shape!.servingSize !== r.packaging.servingSize.value.replace(/\s+/gu, " ").trim()) requireWarning(p.id, "PACKAGING.SERVING_SIZE_CONFLICT");
      }
    }
  }
  if (r.schemaVersion === 4) {
    if (JSON.stringify(r.packaging.observation) !== JSON.stringify(r.observation) || (!imageFirst && r.packaging.blockingIssues.length)) invalid();
    for (const code of r.packaging.blockingIssues) if (!r.warnings.some(w => w.code === code)) invalid();
    const counts = new Set(accepted.map(p => p.candidate.formula?.servingsPerContainer?.text.replace(/\s+/gu, " ").trim()).filter(Boolean));
    for (const claim of r.packaging.servingsPerContainer.claims) counts.add(claim.value.replace(/\s+/gu, " ").trim());
    const conflict = counts.size > 1;
    if (conflict !== r.warnings.some(w => w.code === "PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT")) invalid();
    if (conflict) {
      if (r.formula.servingsPerContainer !== null) invalid();
      for (const p of projectedSources) if (p.formula) p.formula.servingsPerContainer = null;
    }
    for (const code of r.packaging.warnings) if (!r.warnings.some(w => w.code === code)) invalid();
  }
  if (!projectedSources.some(p => p.formula && JSON.stringify(p.formula) === JSON.stringify(r.formula))) invalid();
  if (r.otherIngredients && !projectedSources.some(p => JSON.stringify(p.otherIngredients) === JSON.stringify(r.otherIngredients))) invalid();
  const expected: z.infer<typeof LabelProductIngredientSchema>[] = r.formula.columns.flatMap((c, columnIndex) => c.rows.flatMap((row, rowIndex) => row.kind === "blend_component" ?
    [{ name: row.name, amount: row.amount, role: "blend_component" as const, columnIndex, rowIndex, parentRowIndex: row.parentRowIndex }] : []));
  expected.push(...(r.otherIngredients?.items ?? []).map(name => ({ name, amount: null, role: "other" as const, columnIndex: null, rowIndex: null, parentRowIndex: null })));
  if (JSON.stringify(r.ingredients) !== JSON.stringify(expected.map(i => ({ name: i.name, role: i.role, amount: i.amount, columnIndex: i.columnIndex, rowIndex: i.rowIndex, parentRowIndex: i.parentRowIndex })))) invalid();
});
export type LabelCollectedProduct = z.infer<typeof LabelCollectedProductSchema>;
export type LabelProductField = z.infer<typeof LabelProductFieldSchema>;
export const LabelCollectionInputSchema = z.strictObject({ join: LabelProductJoinSchema, evidenceKey: ObjectKeySchema });
export const LabelProductWorkflowInputSchema = z.strictObject({ manifest: LabelProductManifestSchema,
  queues: z.strictObject({ text: z.string().min(1).max(255), textReceipts: z.string().min(1).max(255), vision: z.string().min(1).max(255),
    assembly: z.string().min(1).max(255), collection: z.string().min(1).max(255) }) });
