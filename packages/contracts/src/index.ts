import { z } from "zod";

export const jobStages = ["capture", "process", "ingest", "cleanup"] as const;
export const jobStates = ["queued", "leased", "running", "retry_wait", "needs_review", "failed", "completed"] as const;
export const nodeCapabilities = ["browser", "amazon", "process", "ingest", "cleanup"] as const;

export const JobStageSchema = z.enum(jobStages);
export const JobStateSchema = z.enum(jobStates);
export const NodeCapabilitySchema = z.enum(nodeCapabilities);

export type JobStage = z.infer<typeof JobStageSchema>;
export type JobState = z.infer<typeof JobStateSchema>;
export type NodeCapability = z.infer<typeof NodeCapabilitySchema>;

export const ArtifactRefSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["evidence_bundle", "codex_raw", "normalized", "review"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  fileName: z.string().min(1),
});

export const EvidenceItemSchema = z.object({
  externalId: z.string().min(1),
  productUrl: z.url(),
  title: z.string().min(1),
  sku: z.string().min(1).nullable(),
  skuMissing: z.boolean(),
  variant: z.record(z.string(), z.unknown()).default({}),
  sourceFiles: z.array(z.string().min(1)),
  imageFiles: z.array(z.string().min(1)),
}).superRefine((value, context) => {
  if ((value.sku === null) !== value.skuMissing) {
    context.addIssue({ code: "custom", message: "sku 与 skuMissing 必须一致" });
  }
});

export const EvidenceBundleV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.uuid(),
  batchId: z.uuid(),
  ordinal: z.number().int().nonnegative(),
  sourceUrl: z.url(),
  sourceType: z.enum(["dtc_browser", "sales_channel"]),
  adapter: z.string().min(1).nullable(),
  capturedAt: z.iso.datetime(),
  itemCount: z.number().int().nonnegative(),
  items: z.array(EvidenceItemSchema),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
  })),
  capture: z.object({
    nodeId: z.string().min(1),
    promptVersion: z.string().min(1),
    skillRevision: z.string().min(1).nullable(),
    pageCount: z.number().int().nonnegative(),
    complete: z.boolean(),
  }),
}).superRefine((value, context) => {
  if (value.itemCount !== value.items.length) {
    context.addIssue({ code: "custom", path: ["itemCount"], message: "itemCount 必须等于 items 长度" });
  }
});

export type EvidenceBundleV1 = z.infer<typeof EvidenceBundleV1Schema>;

export const UrlClassificationSchema = z.object({
  url: z.string(),
  host: z.string(),
  type: z.enum(["dtc_browser", "sales_channel"]),
  adapter: z.enum(["amazon"]).nullable(),
  supported: z.boolean(),
  reason: z.string(),
});

const IsoDate = z.string();
export const RunListItemSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  sourceType: z.string(),
  adapter: z.string().nullable(),
  status: z.string(),
  stages: z.record(z.string(), z.string()),
  itemCount: z.number().int(),
  openReviews: z.number().int(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});

export const NodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  version: z.string(),
  capabilities: z.array(NodeCapabilitySchema),
  maxConcurrency: z.number().int().positive(),
  activeJobs: z.number().int().nonnegative(),
  status: z.enum(["online", "stale", "offline"]),
  lastSeenAt: IsoDate,
});

export const ReviewSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  jobId: z.uuid().nullable(),
  url: z.string(),
  reasonCode: z.string(),
  reasonMessage: z.string(),
  status: z.string(),
  createdAt: IsoDate,
});

export const ChannelStatSchema = z.object({
  adapter: z.string(),
  implemented: z.boolean(),
  enabled: z.boolean(),
  runCount: z.number().int(),
  successCount: z.number().int(),
  failureCount: z.number().int(),
  successRate: z.number(),
  lastRunAt: IsoDate.nullable(),
  lastError: z.string().nullable(),
});
