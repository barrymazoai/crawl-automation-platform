import {
  AcquisitionReviewSchema,
  ChannelPlanInputSchema,
  ExecutionIdSchema,
  FileAcquireInputSchema,
  ResourceGateSchema,
  ReviewCodeSchema,
  ReviewSchema,
  ChannelIdSchema,
  ChannelSavedLabelWorkflowInputSchema,
  type FileAcquireOutcome,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { LabelWorkflowInput } from "./label/label-model.js";

/** Every channel (the one channel list, v3-contracts). */
export const PipelineChannelSchema = ChannelIdSchema;

/** One product of one channel, collected by the shared pipeline. */
export const ProductPipelineInputSchema = z.strictObject({
  codec: z.literal("product-pipeline/1"),
  /** The run this product belongs to (a product run's ID, or a brand run's catalog ID). */
  runId: z.uuid(),
  channel: PipelineChannelSchema,
  /** Selected from the adapter's captureModes; absent in workflows started before capability routing. */
  capture: z.enum(["http", "browser"]).optional(),
  url: z.url().max(4096),
  brandId: z.uuid(),
  sourceId: z.uuid(),
  /** Catalog of sourceId, captured at acceptance; no default alters old history payloads. */
  sourceUrl: z.url().max(4096).optional(),
  /** Unique per product per run; names its archive, projection and plan. */
  operationId: ExecutionIdSchema,
  queues: z.strictObject({
    /** The pipeline worker host: capture, handoff, files, Reviews, formula lookup. */
    activities: z.string().min(1).max(200),
    /** The formula planner (the pipeline worker hosts it too): plans the formula sources. */
    plan: z.string().min(1).max(200),
    /** Where the Label workflow runs. */
    label: z.string().min(1).max(200),
    /** Pages captured in the browser, on the machine that runs Ego. */
    browser: z.string().min(1).max(200).optional(),
  }),
  /** Permit gates; `captureProduct` must take the capture lane. */
  resources: ResourceGateSchema,
});
export type ProductPipelineInput = z.infer<typeof ProductPipelineInputSchema>;

/** The revisit found the listing unlisted; the sighting and its reason are recorded and the product ends here. */
export const ListingResultSchema = z.strictObject({
  status: z.literal("listing"),
  state: z.literal("unlisted"),
  // The same reasons as channels-core's UNLISTED_REASONS (this package does not depend on channels-core).
  reason: z.enum([
    "not_found",
    "redirected_to_other_product",
    "redirected_away",
    "identity_conflict",
  ]),
  operationId: ExecutionIdSchema,
  observationId: z.string().regex(/^[a-f0-9]{64}$/),
  listingId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200).nullable(),
  causeCode: z.string().min(1).max(120),
});

export const CaptureResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("captured"),
    sourcePlan: ChannelPlanInputSchema,
    /** Whether the page's own facts text is complete enough to read the formula without images. */
    factsComplete: z.boolean(),
    /** The page's facts as text, for the sibling-formula label check (absent in earlier histories). */
    labelText: z.string().max(200_000).nullable().optional(),
    /** The product's family as the adapter read it; checked by the reuse activity (absent in earlier histories). */
    family: z.unknown().optional(),
  }),
  z.strictObject({
    status: z.literal("captured-family"),
    listingId: z.string().min(1).max(200),
    variantId: z.string().min(1).max(200).nullable(),
    archiveKey: z.string().min(1).max(1024),
  }),
  AcquisitionReviewSchema,
  ListingResultSchema,
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

/**
 * A product without a formula of its own, with what its page showed: its family and its facts text. When the page
 * prints no facts text, a second ask carries the facts image's keyword selection, whose OCR text is the label.
 */
export const SiblingReuseRequestSchema = FormulaRequestSchema.extend({
  family: z.unknown(),
  labelText: z.string().max(200_000).nullable(),
  labelImage: z.unknown().optional(),
});
export type SiblingReuseRequest = z.infer<typeof SiblingReuseRequestSchema>;

/** A sibling's formula linked after a passed label check, or full extraction with the reason why not. */
export const SiblingReuseResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("reused"),
    formulaOperationId: z.string().min(1).max(300),
    linkId: z.string().regex(/^[a-f0-9]{64}$/),
    siblingListingId: z.string().min(1).max(200),
    siblingVariantId: z.string().min(1).max(200).nullable(),
    coverage: z.unknown().optional(),
  }),
  z.strictObject({
    status: z.literal("extract"),
    reason: z.string().min(1).max(120),
    coverage: z.unknown().optional(),
  }),
]);

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
  /** Absent in old histories; wait expiry proves that capture never started. */
  executionFact: ReviewSchema.shape.executionFact.optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

/** The pipeline worker host's activities. Each validates its input with the schema above. */
export interface PipelineActivities {
  captureProduct(input: ProductPipelineInput): Promise<unknown>;
  findKnownFormula(request: FormulaRequest): Promise<unknown>;
  reuseSiblingFormula(request: SiblingReuseRequest): Promise<unknown>;
  /** The earlier per-channel label workflow's input (kept for histories recorded before the shared one). */
  prepareLabelHandoff(request: LabelHandoffRequest): Promise<ChannelSavedLabelWorkflowInput>;
  /** The shared Label workflow's input for the planned product. */
  prepareLabelTask(request: LabelHandoffRequest): Promise<LabelWorkflowInput>;
  acquireProductFile(request: FileRequest): Promise<FileAcquireOutcome>;
  reviewProduct(request: ReviewRequest): Promise<AcquisitionReview>;
  /** Holds an ASIN that has no Amazon formula yet in Amazon's queue, once per ASIN. */
  requestAmazonFormula(request: AmazonFormulaRequest): Promise<unknown>;
}

/** An ASIN seen on a channel that shares Amazon's formulas, without an Amazon formula yet. */
export const AmazonFormulaRequestSchema = z.strictObject({
  brandId: z.uuid(),
  listingId: z.string().min(1).max(200),
  /** New family outcome protocol; absent from historical activity commands. */
  formulaOperationId: z.string().min(1).max(300).nullable().optional(),
  metrics: z
    .strictObject({
      operationId: ExecutionIdSchema,
      runId: z.uuid(),
      channel: z.literal("wholefoods"),
      variantId: z.string().nullable(),
      archiveKey: z.string().min(1).max(1024),
    })
    .optional(),
});
export type AmazonFormulaRequest = z.infer<typeof AmazonFormulaRequestSchema>;

/** The formula planner's activity: plans the formula sources (metrics are recorded at capture). */
export interface PlanActivities {
  prepareChannelProduct(request: ProductPlanRequest): Promise<unknown>;
}

/** Activity-only source context; the retained ChannelPlanInput contract stays unchanged. */
export const ProductPlanRequestSchema = ChannelPlanInputSchema.safeExtend({
  sourceUrl: z.url().max(4096).optional(),
});
export type ProductPlanRequest = z.infer<typeof ProductPlanRequestSchema>;

/** A page read in the browser (its metrics are recorded at capture), or the listing's unlisted sighting, or a Review. */
export const BrowserCaptureResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("captured"),
    listingId: z.string().min(1).max(200),
    variantId: z.string().min(1).max(200).nullable(),
    archiveKey: z.string().min(1).max(1024),
    /** Browser adapters with their own formulas use the shared planning and Label path. */
    planned: CaptureResultSchema.options[0].optional(),
  }),
  AcquisitionReviewSchema,
  ListingResultSchema,
]);

/** The browser worker's activity (Server 二): reads one product page in Ego and archives it before parsing. */
export interface BrowserActivities {
  captureBrowserProduct(input: ProductPipelineInput): Promise<unknown>;
}
