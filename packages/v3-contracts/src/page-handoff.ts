import { z } from "zod";
import { ArtifactRefSchema, ExecutionIdSchema, assertArtifactBelongsTo } from "./artifacts.js";
import { PagePrepareInputSchema, AcquisitionReviewSchema } from "./acquisition.js";
import { TextCompatibilitySchema, TextInputSchema } from "./text.js";
import { observationIdentity } from "./processing.js";
export const PageTablesSchema = z.array(z.strictObject({ index: z.number().int().nonnegative(),
  rows: z.array(z.array(z.strictObject({ text: z.string(), header: z.boolean(),
    rowspan: z.number().int().min(0).max(1000), colspan: z.number().int().min(0).max(1000) })).max(20000)).max(100000),
})).max(200).refine(tables => tables.every((t, i) => t.index === i) && tables.reduce((n, t) => n + t.rows.reduce((m, r) => m + r.length, 0), 0) <= 20000);
export const PreparedPageRecordSchema = z.strictObject({ schemaVersion: z.literal(1), codec: z.literal("prepared-page/1"),
  input: PagePrepareInputSchema, document: ArtifactRefSchema, tables: ArtifactRefSchema,
  textLength: z.number().int().positive().max(200000),
}).superRefine((r, ctx) => {
  const refs = [r.input.page, r.document, r.tables];
  if (new Set(refs.map(f => f.artifactId)).size !== 3 || new Set(refs.map(f => f.objectKey)).size !== 3)
    ctx.addIssue({ code: "custom", message: "Page artifacts must be distinct" });
  for (const ref of [r.document, r.tables]) {
    try { assertArtifactBelongsTo(ref, observationIdentity(r.input)); } catch { ctx.addIssue({ code: "custom", message: "Page output owner mismatch" }); }
    if (ref.kind !== "result-json" || ref.producer.module !== "page.prepare" || ref.producer.operationId !== r.input.operationId || ref.producer.implementationVersion !== r.input.implementationVersion)
      ctx.addIssue({ code: "custom", message: "Page output producer mismatch" });
  }
});
export type PreparedPageRecord = z.infer<typeof PreparedPageRecordSchema>;
export const PagePrepareOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("durable"), record: PreparedPageRecordSchema }), AcquisitionReviewSchema,
]);
export type PagePrepareOutcome = z.infer<typeof PagePrepareOutcomeSchema>;
export const PageTextPlanSchema = z.strictObject({ page: PagePrepareInputSchema, textOperationId: ExecutionIdSchema,
  text: TextCompatibilitySchema.refine(c => c.resultSchemaVersion === 2),
}).refine(p => p.textOperationId !== p.page.operationId && p.page.operationId !== p.page.page.producer.operationId &&
  p.textOperationId !== p.page.page.producer.operationId, "Independent operations required");
export const PageTextPrepareInputSchema = z.strictObject({ plan: PageTextPlanSchema, receipt: PagePrepareOutcomeSchema.nullable() });
export type PageTextPrepareInput = z.infer<typeof PageTextPrepareInputSchema>;
export const PageTextPrepareOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("prepared"), task: TextInputSchema }), AcquisitionReviewSchema,
]);
export const PageTextWorkflowInputSchema = z.strictObject({ plan: PageTextPlanSchema,
  queues: z.strictObject({ page: z.string().min(1).max(255), prepare: z.string().min(1).max(255),
    text: z.string().min(1).max(255), receipts: z.string().min(1).max(255) }),
});
