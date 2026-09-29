import {
  AcquisitionReviewSchema,
  ChannelPlanInputSchema,
  ExecutionIdSchema,
  ResourceGateSchema,
  ChannelSavedLabelWorkflowInputSchema,
  type ChannelPlanInput,
  type FileAcquireInput,
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
]);
export type CaptureResult = z.infer<typeof CaptureResultSchema>;

type AcquisitionReview = z.infer<typeof AcquisitionReviewSchema>;
type ChannelSavedLabelWorkflowInput = z.infer<typeof ChannelSavedLabelWorkflowInputSchema>;

export const KnownFormulaSchema = z
  .strictObject({ operationId: z.string().min(1).max(300) })
  .nullable();

export interface FormulaKey {
  channel: z.infer<typeof PipelineChannelSchema>;
  listingId: string;
  variantId: string | null;
}

/** The pipeline worker host's activities. */
export interface PipelineActivities {
  captureProduct(input: ProductPipelineInput): Promise<unknown>;
  findKnownFormula(key: FormulaKey): Promise<unknown>;
  prepareLabelHandoff(input: {
    pipeline: ProductPipelineInput;
    sourcePlan: ChannelPlanInput;
  }): Promise<ChannelSavedLabelWorkflowInput>;
  acquireProductFile(input: {
    pipeline: ProductPipelineInput;
    sourcePlan: ChannelPlanInput;
    acquire: FileAcquireInput;
  }): Promise<FileAcquireOutcome>;
  reviewProduct(input: {
    pipeline: ProductPipelineInput;
    code: string;
    causeCode: string | null;
  }): Promise<AcquisitionReview>;
}

/** The existing channel-plan worker's activity: saves metrics, then plans the formula sources. */
export interface PlanActivities {
  prepareChannelProduct(sourcePlan: ChannelPlanInput): Promise<unknown>;
}
