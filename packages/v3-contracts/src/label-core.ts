import { z } from "zod";
import { ArtifactRefSchema, ObservationSchema, assertArtifactBelongsTo } from "./artifacts.js";
export const LabelCoreInputSchema = z.strictObject({ owner: ObservationSchema, fullDocument: ArtifactRefSchema }).superRefine((i, ctx) => {
  try { assertArtifactBelongsTo(i.fullDocument, i.owner); } catch { ctx.addIssue({ code: "custom", message: "Core source identity conflict" }); }
  // sourceId identifies a Brand source record, not the channel. The preparation
  // verifies the original artifact's gnc.product-input provenance separately.
  if (i.fullDocument.kind !== "result-json" || i.fullDocument.producer.module !== "page.prepare")
    ctx.addIssue({ code: "custom", message: "Core source unsupported" });
});
export const LabelCoreOutcomeSchema = z.strictObject({ status: z.literal("prepared"), input: LabelCoreInputSchema,
  document: ArtifactRefSchema, range: z.strictObject({ start: z.literal(0), end: z.number().int().positive().max(200000) }),
}).superRefine((r, ctx) => {
  try { assertArtifactBelongsTo(r.document, r.input.owner); } catch { ctx.addIssue({ code: "custom", message: "Core result identity conflict" }); }
  if (r.document.kind !== "result-json" || r.document.producer.module !== "label.core.prepare" || !["gnc-label-core/1","swanson-label-core/1"].includes(r.document.producer.implementationVersion))
    ctx.addIssue({ code: "custom", message: "Core result unsupported" });
});
export type LabelCoreInput = z.infer<typeof LabelCoreInputSchema>;
export type LabelCoreOutcome = z.infer<typeof LabelCoreOutcomeSchema>;
export const LabelCoreWorkflowInputSchema = z.strictObject({ input: LabelCoreInputSchema, queue: z.string().min(1).max(255) });
