import { z } from "zod";
import {
  ExecutionIdSchema,
  LabelEvidencePolicySchema,
  LabelProductManifestSchema,
  LabelProductSourceSchema,
  ObservationSchema,
  ProductEvidenceJoinSchema,
  SavedProductWorkflowInputSchema,
  Sha256Schema,
  TextCompatibilitySchema,
  type ProductResolvedEvidenceSource,
  type SavedEvidenceSource,
} from "@crawl-automation/v3-contracts";

/**
 * A label task for any channel: the channel's product plan it is built from (opaque here), the text and vision
 * setups, and the label policies. The channel maps its own plan input onto this.
 */
export const LabelPlanInputSchema = z
  .strictObject({
    operationId: ExecutionIdSchema,
    owner: ObservationSchema,
    plan: z.strictObject({
      operationId: ExecutionIdSchema,
      /** The operation that captured the plan's source (the plan's producer). */
      sourceOperationId: ExecutionIdSchema,
      /** The channel's own plan input; only the channel's plan reader interprets it. */
      input: z.json(),
    }),
    text: TextCompatibilitySchema.refine((text) => text.resultSchemaVersion === 3),
    visionConfigFingerprint: Sha256Schema,
    corePolicy: z.string().min(1).max(120).optional(),
    evidencePolicy: LabelEvidencePolicySchema.optional(),
    /** Packaging admission: the label is compared with the product's full page documents. */
    admission: z.literal("label-packaging/1").optional(),
  })
  .refine(
    (input) => ![input.plan.operationId, input.plan.sourceOperationId].includes(input.operationId),
    "The label task is its own operation",
  );
export type LabelPlanInput = z.infer<typeof LabelPlanInputSchema>;

export const LabelSourceRequestSchema = z.strictObject({
  input: LabelPlanInputSchema,
  sourceId: ExecutionIdSchema,
});
export type LabelSourceRequest = z.infer<typeof LabelSourceRequestSchema>;

export const LabelSourceResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("prepared"),
    input: LabelSourceRequestSchema,
    source: LabelProductSourceSchema,
  }),
  z.strictObject({
    status: z.literal("not_matched"),
    input: LabelSourceRequestSchema,
    reason: z.literal("no_text").optional(),
  }),
]);
export type LabelSourceResult = z.infer<typeof LabelSourceResultSchema>;

export const LabelManifestResultSchema = z.strictObject({
  input: LabelPlanInputSchema,
  manifest: LabelProductManifestSchema,
  skipped: z.array(ExecutionIdSchema).max(100),
});
export type LabelManifestResult = z.infer<typeof LabelManifestResultSchema>;

const NotStartedSchema = z.strictObject({
  id: ExecutionIdSchema,
  status: z.literal("not_started"),
});

/** An image-first selection: which image holds the complete label, and every source's state at that point. */
export const LabelSelectionSchema = z
  .strictObject({
    input: LabelPlanInputSchema,
    selectedImageId: ExecutionIdSchema.nullable(),
    states: z
      .array(z.union([ProductEvidenceJoinSchema.shape.states.element, NotStartedSchema]))
      .max(100),
  })
  .refine((selection) => selection.input.evidencePolicy === "label-image-first/5");
export type LabelSelection = z.infer<typeof LabelSelectionSchema>;
export type SourceState = LabelSelection["states"][number];

export type SavedManifest = z.infer<typeof SavedProductWorkflowInputSchema.shape.manifest>;

/** The channel's product plan as its reader verified it, with the image URLs used as ordering hints. */
export interface ProductPlanReader {
  inspect(
    plan: LabelPlanInput["plan"],
    signal: AbortSignal,
  ): Promise<{ manifest: SavedManifest; files?: { resourceId: string; url: string }[] } | null>;
}

/** What a saved source's prepared evidence resolves to (see SavedSourceEvidence). */
export type SourceResolution =
  | { status: "resolved"; source: ProductResolvedEvidenceSource }
  | { status: "not_matched"; reason?: "no_text" }
  | { status: "review"; code: string };

export type SourceResolver = (
  source: SavedEvidenceSource,
  signal: AbortSignal,
) => Promise<SourceResolution>;

export const labelKeys = {
  source: (input: LabelPlanInput, sourceId: string) =>
    `v3/channel-labels/${input.operationId}/sources/${sourceId}.json`,
  selection: (input: LabelPlanInput) => `v3/channel-labels/${input.operationId}/selection.json`,
  manifest: (input: LabelPlanInput) => `v3/channel-labels/${input.operationId}/manifest.json`,
};
