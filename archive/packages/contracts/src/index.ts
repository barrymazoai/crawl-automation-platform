import { z } from "zod";

// v1（单体串行）阶段 + v2（并行流水线）阶段。v2 中 Batch 的发布由 capture.ready.json
// 标记 + registerCaptureBatch 记录，不设单独的 capture_batch_finalize job。
export const jobStages = [
  "capture", "process", "ingest", "cleanup",
  "capture_catalog", "process_text", "process_images", "product_join", "product_unify",
  "catalog_finalize", "ingest_staging", "cleanup_run",
  // 解析线：把渠道品牌目录抓下来，供公司↔品牌匹配使用（与抓取线并行）
  "resolve_brand_catalog",
] as const;
export const jobStates = ["queued", "leased", "running", "retry_wait", "needs_review", "failed", "completed"] as const;
export const nodeCapabilities = [
  "browser", "amazon", "gnc", "swanson", "process", "ingest", "cleanup",
  "dtc", "process_text", "process_images", "product_join", "product_unify",
  "catalog_finalize", "ingest_staging", "cleanup_run",
] as const;

export const JobStageSchema = z.enum(jobStages);
export const JobStateSchema = z.enum(jobStates);
export const NodeCapabilitySchema = z.enum(nodeCapabilities);
export const SalesChannelAdapterSchema = z.enum(["amazon", "gnc", "swanson"]);

export type JobStage = z.infer<typeof JobStageSchema>;
export type JobState = z.infer<typeof JobStateSchema>;
export type NodeCapability = z.infer<typeof NodeCapabilitySchema>;
export type SalesChannelAdapter = z.infer<typeof SalesChannelAdapterSchema>;

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

// ---------------------------------------------------------------------------
// CapturedProductBatchV1：v2 并行流水线的统一抓取产物契约。
// 所有 Adapter（DTC 转换后、Amazon/GNC/Swanson 直接产出）发布相同结构，
// 下游 Text / Image / Join / Unify 处理线只认这一种输入。
// ---------------------------------------------------------------------------

export const CapturedFactsEvidenceSchema = z.object({
  htmlTable: z.string().min(1).nullable(),
  pdfUrl: z.url().nullable(),
  imageRefs: z.array(z.string().min(1)),
});

export const CapturedProductV1Schema = z.object({
  externalId: z.string().min(1).nullable(),
  sku: z.string().min(1).nullable(),
  productUrl: z.url(),
  brandRaw: z.string().min(1).nullable(),
  titleRaw: z.string().min(1),
  price: z.string().min(1).nullable(),
  currency: z.string().min(1).nullable(),
  availability: z.string().min(1).nullable(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  unitsSoldText: z.string().min(1).nullable(),
  rawVariantAttrs: z.record(z.string(), z.unknown()),
  descriptionText: z.string().nullable(),
  detailText: z.string().nullable(),
  ingredientText: z.string().nullable(),
  factsEvidence: CapturedFactsEvidenceSchema,
  images: z.array(z.string().min(1)),
  sourceFiles: z.array(z.string().min(1)),
  captureCompleteness: z.enum(["full", "partial"]),
  capturedAt: z.iso.datetime(),
});

export const CapturedProductBatchV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  sourceType: z.enum(["dtc_browser", "sales_channel"]),
  channel: z.string().min(1),
  adapter: z.string().min(1).nullable(),
  runId: z.uuid(),
  batchId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  catalogKey: z.string().min(1).nullable(),
  capturedAt: z.iso.datetime(),
  itemCount: z.number().int().nonnegative(),
  products: z.array(CapturedProductV1Schema),
}).superRefine((value, context) => {
  if (value.itemCount !== value.products.length) {
    context.addIssue({ code: "custom", path: ["itemCount"], message: "itemCount 必须等于 products 长度" });
  }
});

export type CapturedFactsEvidence = z.infer<typeof CapturedFactsEvidenceSchema>;
export type CapturedProductV1 = z.infer<typeof CapturedProductV1Schema>;
export type CapturedProductBatchV1 = z.infer<typeof CapturedProductBatchV1Schema>;

export const UrlClassificationSchema = z.object({
  url: z.string(),
  host: z.string(),
  type: z.enum(["dtc_browser", "sales_channel"]),
  adapter: SalesChannelAdapterSchema.nullable(),
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
  // v2：每 stage 的 Batch 级进度（品牌运行矩阵的分段进度条数据源）。
  stageProgress: z.record(z.string(), z.object({
    total: z.number().int(),
    completed: z.number().int(),
    active: z.number().int(),
    queued: z.number().int(),
    review: z.number().int(),
    failed: z.number().int(),
  })).default({}),
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
