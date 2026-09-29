import {
  AcquisitionReviewSchema,
  ChannelPlanInputSchema,
  ExecutionIdSchema,
  FileAcquireInputSchema,
  ResourceGateSchema,
  ReviewCodeSchema,
  ChannelSavedLabelWorkflowInputSchema,
  type ChannelPlanInput,
  type FileAcquireOutcome,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";

export const PipelineChannelSchema = z.enum([
  "amazon",
  "gnc",
  "swanson",
  "dtc",
  "costco",
  "wholefoods",
]);

/** One product of one channel, collected by the shared pipeline. */
export const ProductPipelineInputSchema = z.strictObject({
  codec: z.literal("product-pipeline/1"),
  /** The run this product belongs to (a product run's ID, or a brand run's catalog ID). */
  runId: z.uuid(),
  channel: PipelineChannelSchema,
  url: z.url().max(4096),
  brandId: z.uuid(),
  sourceId: z.uuid(),
  /** Unique per product per run; names its archive, projection and plan. */
  operationId: ExecutionIdSchema,
  queues: z.strictObject({
    /** The pipeline worker host: capture, handoff, files, Reviews, formula lookup. */
    activities: z.string().min(1).max(200),
    /** The existing channel-plan worker: saves metrics and plans the formula sources. */
    plan: z.string().min(1).max(200),
    /** The existing label workflow worker. */
    label: z.string().min(1).max(200),
  }),
  /** Permit gates; `captureProduct` must take the capture lane. */
  resources: ResourceGateSchema,
});
export type ProductPipelineInput = z.infer<typeof ProductPipelineInputSchema>;

export const CaptureResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("captured"),
    sourcePlan: ChannelPlanInputSchema,
    /** Whether the page's own facts text is complete enough to read the formula without images. */
    factsComplete: z.boolean(),
  }),
  AcquisitionReviewSchema,
  /** The revisit found the listing gone or superseded; the sighting is recorded and the product ends here. */
  z.strictObject({
    status: z.literal("listing"),
    state: z.enum(["gone", "superseded"]),
    operationId: ExecutionIdSchema,
    observationId: z.string().regex(/^[a-f0-9]{64}$/),
    listingId: z.string().min(1).max(200),
    variantId: z.string().min(1).max(200).nullable(),
    causeCode: z.string().min(1).max(120),
  }),
]);
export type CaptureResult = z.infer<typeof CaptureResultSchema>;

type AcquisitionReview = z.infer<typeof AcquisitionReviewSchema>;
type ChannelSavedLabelWorkflowInput = z.infer<typeof ChannelSavedLabelWorkflowInputSchema>;

export const KnownFormulaSchema = z
  .strictObject({ operationId: z.string().min(1).max(300) })
  .nullable();

export const FormulaKeySchema = z.strictObject({
  channel: PipelineChannelSchema,
  listingId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200).nullable(),
});
export type FormulaKey = z.infer<typeof FormulaKeySchema>;

/** The formula lookup's input: the key, and the run asking (so its log lines carry the run ID). */
export const FormulaRequestSchema = FormulaKeySchema.extend({ runId: z.uuid() });
export type FormulaRequest = z.infer<typeof FormulaRequestSchema>;

export const LabelHandoffRequestSchema = z.strictObject({
  pipeline: ProductPipelineInputSchema,
  sourcePlan: ChannelPlanInputSchema,
});
export type LabelHandoffRequest = z.infer<typeof LabelHandoffRequestSchema>;

export const FileRequestSchema = z.strictObject({
  pipeline: ProductPipelineInputSchema,
  sourcePlan: ChannelPlanInputSchema,
  acquire: FileAcquireInputSchema,
});
export type FileRequest = z.infer<typeof FileRequestSchema>;

export const ReviewRequestSchema = z.strictObject({
  pipeline: ProductPipelineInputSchema,
  code: ReviewCodeSchema,
  causeCode: z.string().max(120).nullable(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

/** The pipeline worker host's activities. Each validates its input with the schema above. */
export interface PipelineActivities {
  captureProduct(input: ProductPipelineInput): Promise<unknown>;
  findKnownFormula(request: FormulaRequest): Promise<unknown>;
  prepareLabelHandoff(request: LabelHandoffRequest): Promise<ChannelSavedLabelWorkflowInput>;
  acquireProductFile(request: FileRequest): Promise<FileAcquireOutcome>;
  reviewProduct(request: ReviewRequest): Promise<AcquisitionReview>;
}

/** The existing channel-plan worker's activity: saves metrics, then plans the formula sources. */
export interface PlanActivities {
  prepareChannelProduct(sourcePlan: ChannelPlanInput): Promise<unknown>;
}
