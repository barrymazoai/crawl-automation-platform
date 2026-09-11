import { z } from "zod";
import { ArtifactRefSchema, ObservationSchema, ExecutionIdSchema, Sha256Schema, ObjectKeySchema, assertArtifactBelongsTo } from "./artifacts.js";

export const ImageEvidenceSchema = ArtifactRefSchema.refine(f => f.kind === "source-image" || f.kind === "pdf-page");
export const KeywordPolicySchema = z.strictObject({
  version: z.literal("label-keywords/1"),
  keywords: z.array(z.string().regex(/^[A-Za-z]+(?: [A-Za-z]+)*$/).max(100)).min(1).max(50)
    .refine(terms => new Set(terms.map(t => t.toLowerCase())).size === terms.length),
});
export const DefaultKeywordPolicy = KeywordPolicySchema.parse({ version: "label-keywords/1",
  keywords: ["Supplement Facts", "Nutrition Facts", "Ingredients", "Other Ingredients"] });
export const KeywordResultSchema = z.strictObject({
  schemaVersion: z.literal(1), observation: ObservationSchema, image: ImageEvidenceSchema,
  ocrOperationId: ExecutionIdSchema, ocrTextSha256: Sha256Schema,
  policy: KeywordPolicySchema, policyFingerprint: Sha256Schema,
  status: z.enum(["matched", "not_matched"]), matchedKeywords: z.array(z.string()).max(50),
}).superRefine((r, ctx) => {
  try { assertArtifactBelongsTo(r.image, r.observation); } catch { ctx.addIssue({ code: "custom", message: "Image ownership conflict" }); }
  if ((r.status === "matched") !== (r.matchedKeywords.length > 0) ||
    r.matchedKeywords.some(k => !r.policy.keywords.includes(k)) || new Set(r.matchedKeywords).size !== r.matchedKeywords.length)
    ctx.addIssue({ code: "custom", message: "Keyword result mismatch" });
});
export type KeywordResult = z.infer<typeof KeywordResultSchema>;
export const KeywordReceiptSchema = z.strictObject({ status: z.enum(["matched", "not_matched"]),
  imageId: ExecutionIdSchema, evidenceKey: ObjectKeySchema, selection: KeywordResultSchema,
}).refine(r => r.status === r.selection.status && r.imageId === r.selection.image.artifactId, "Keyword receipt mismatch");
export type KeywordReceipt = z.infer<typeof KeywordReceiptSchema>;
export const VisionInputSchema = z.strictObject({ operationId: ExecutionIdSchema, selection: KeywordResultSchema,
  extractionProtocol: z.enum(["label-extraction/1", "label-extraction/2"]).optional() })
  .refine(r => r.selection.status === "matched", "Vision requires a keyword match");
export type VisionInput = z.infer<typeof VisionInputSchema>;
// A scheduled task is pinned to the provider configuration, not just a machine/queue name.
export const VisionTaskSchema = z.strictObject({ input: VisionInputSchema, configFingerprint: Sha256Schema });
export type VisionTask = z.infer<typeof VisionTaskSchema>;
export const VisionRecordSchema = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]),
  codec: z.enum(["vision-result/1", "vision-result/2"]),
  storageId: z.string().min(1).max(120), input: VisionInputSchema, configFingerprint: Sha256Schema,
  status: z.enum(["candidate", "partial"]), result: ArtifactRefSchema, completion: ArtifactRefSchema,
}).superRefine((r, ctx) => {
  const version = r.input.extractionProtocol ? 2 : 1;
  if (r.schemaVersion !== version || r.codec !== `vision-result/${version}`)
    ctx.addIssue({ code: "custom", message: "Vision protocol version conflict" });
  for (const ref of [r.result, r.completion]) {
    try { assertArtifactBelongsTo(ref, r.input.selection.observation); }
    catch { ctx.addIssue({ code: "custom", message: "Vision result ownership conflict" }); }
    if (ref.kind !== "result-json" || ref.mediaType !== "application/json" || ref.producer.operationId !== r.input.operationId ||
      ref.producer.module !== "codex.vision" || ref.producer.implementationVersion !== `vision/${version}`)
      ctx.addIssue({ code: "custom", message: "Vision result producer conflict" });
  }
  if (r.result.objectKey === r.completion.objectKey || r.result.artifactId === r.completion.artifactId)
    ctx.addIssue({ code: "custom", message: "Distinct result and completion required" });
});
export type VisionRecord = z.infer<typeof VisionRecordSchema>;

const text = z.string().trim().min(1).max(4000);
const field = z.strictObject({ text, evidence: text });
const nutrient = z.strictObject({ name: field, amount: field.nullable(), dailyValue: field.nullable() });
// Image-backed evidence, never fabricated OCR character offsets. Schema checks are not visual proof.
export const VisionCandidateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  formula: z.strictObject({ servingSize: field.nullable(), servingsPerContainer: field.nullable(),
    columns: z.array(z.strictObject({ heading: text, nutrients: z.array(nutrient).min(1).max(100) })).min(1).max(8),
  }).nullable(),
  ingredients: z.array(z.strictObject({ name: text, evidence: text, role: z.enum(["blend_component", "other"]),
    parentBlend: text.nullable() })).max(400),
  formulaComplete: z.boolean(), ingredientsComplete: z.boolean(),
  issues: z.array(z.strictObject({ code: z.enum(["UNREADABLE", "AMBIGUOUS", "FORMULA_MISSING", "INGREDIENTS_MISSING"]), detail: text })).max(100),
});
export type VisionCandidate = z.infer<typeof VisionCandidateSchema>;
export function imageActivityOptions(taskQueue: string) {
  return { taskQueue, startToCloseTimeout: "5 minutes" as const, scheduleToCloseTimeout: "15 minutes" as const,
    heartbeatTimeout: "10 seconds" as const, retry: { maximumAttempts: 1 } };
}
