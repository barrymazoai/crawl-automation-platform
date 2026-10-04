import {
  ExecutionIdSchema,
  ImageOcrPrepareOutcomeSchema,
  LabelEvidencePolicySchema,
  LabelSourcePolicySchema,
  LabelPreparationSchema,
  LabelProductManifestSchema,
  LabelProductSourceSchema,
  ObservationSchema,
  ProductEvidenceJoinSchema,
  ResourceGateSchema,
  SavedProductWorkflowInputSchema,
  Sha256Schema,
  TextCompatibilitySchema,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";

const queue = z.string().min(1).max(200);

/**
 * One product's label task, for every channel. It mirrors processing's `LabelPlanInputSchema` field for field: the
 * workflow bundle cannot load the processing package, and every activity re-checks the task with that schema.
 */
export const LabelTaskSchema = z
  .strictObject({
    operationId: ExecutionIdSchema,
    owner: ObservationSchema,
    plan: z.strictObject({
      operationId: ExecutionIdSchema,
      sourceOperationId: ExecutionIdSchema,
      input: z.json(),
    }),
    text: TextCompatibilitySchema.refine((text) => text.resultSchemaVersion === 3),
    visionConfigFingerprint: Sha256Schema,
    corePolicy: z.string().min(1).max(120).optional(),
    evidencePolicy: LabelEvidencePolicySchema.optional(),
    sourcePolicy: LabelSourcePolicySchema.optional(),
    failurePolicy: z.literal("source-failure-first/1").optional(),
    admission: z.literal("label-packaging/1").optional(),
  })
  .refine(
    (input) => !input.sourcePolicy || input.evidencePolicy === "label-image-first/6",
    "Ordered labels retain the current merge safeguards",
  );
export type LabelTask = z.infer<typeof LabelTaskSchema>;

/** The Label workflow's input: the task, its three task queues and its permits. */
export const LabelWorkflowInputSchema = z.strictObject({
  input: LabelTaskSchema,
  queues: z.strictObject({
    /** Plans, pages, label core, image preparation, receipts, keywords, manifests, assembly and collection. */
    activities: queue,
    /** OCR API calls. */
    ocr: queue,
    /** Text and vision model calls. */
    model: queue,
  }),
  resources: ResourceGateSchema.optional(),
});
export type LabelWorkflowInput = z.infer<typeof LabelWorkflowInputSchema>;
export type QueueKind = keyof LabelWorkflowInput["queues"];

export type Manifest = z.infer<typeof SavedProductWorkflowInputSchema.shape.manifest>;
export type Source = Manifest["sources"][number];
export type ImageSource = Extract<Source, { kind: "file-image" }>;
export type State = z.infer<typeof ProductEvidenceJoinSchema.shape.states.element>;
export type Status = "unresolved" | "rejected" | "registered" | "not_matched";

/** Image preparation's answer: an OCR task or a Review, or a downloaded PDF skipped (PDFs are not processed). */
export const ImagePrepareSchema = z.union([
  ImageOcrPrepareOutcomeSchema,
  z.strictObject({
    status: z.literal("skipped"),
    operationId: ExecutionIdSchema,
    reason: z.literal("pdf"),
  }),
]);

export const LoadedPlanSchema = z.strictObject({
  input: LabelTaskSchema,
  manifest: SavedProductWorkflowInputSchema.shape.manifest,
  imageOrder: z.array(ExecutionIdSchema).max(100).optional(),
  labelPreparation: LabelPreparationSchema.optional(),
});

const SourceRequestSchema = z.strictObject({ input: LabelTaskSchema, sourceId: ExecutionIdSchema });

export const SourceResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("prepared"),
    input: SourceRequestSchema,
    source: LabelProductSourceSchema,
  }),
  z.strictObject({
    status: z.literal("not_matched"),
    input: SourceRequestSchema,
    reason: z.literal("no_text").optional(),
  }),
]);

export const ImageCheckSchema = z.strictObject({
  input: SourceRequestSchema,
  complete: z.boolean(),
});

export const ManifestResultSchema = z.strictObject({
  input: LabelTaskSchema,
  manifest: LabelProductManifestSchema,
  skipped: z.array(ExecutionIdSchema).max(100),
});
export type ManifestResult = z.infer<typeof ManifestResultSchema>;
