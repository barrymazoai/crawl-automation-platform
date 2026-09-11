import { isAbsolute } from "node:path";
import { z } from "zod";
import { CatalogScopeSchema, ChannelPlanInputSchema, ChannelLabelInputSchema, ChannelSavedLabelWorkflowInputSchema,
  AmazonProductJobSchema, ResourceGateSchema, VersionTagSchema } from "@crawl-automation/v3-contracts";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { EgoTaskSpaceSchema } from "@crawl-automation/v3-acquisition";
export const AmazonLiveConfigSchema = z.strictObject({
  clusterId: VersionTagSchema,
  database: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }),
  resourceDatabase: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }).optional(),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  journalRoot: z.string().refine(isAbsolute), pageJournalRoot: z.string().refine(isAbsolute), cacheRoot: z.string().refine(isAbsolute),
  browser: EgoTaskSpaceSchema, browserResource: VersionTagSchema, egressId: VersionTagSchema,
  scope: CatalogScopeSchema.refine(s => s.channel === "amazon"), brandName: z.string().min(1).max(1000),
  catalogQueue: VersionTagSchema, catalogQueues: z.strictObject({ source: VersionTagSchema, ledger: VersionTagSchema, product: VersionTagSchema }),
  catalogResources: ResourceGateSchema,
  catalogPages: z.array(z.string().url()).min(1).max(10), selectedAsins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).min(1).max(100).nullable(),
  maxPages: z.number().int().min(1).max(10).optional(),
  productQueues: AmazonProductJobSchema.shape.queues, productResources: ResourceGateSchema,
  sourceText: ChannelPlanInputSchema.shape.text, ocr: ChannelPlanInputSchema.shape.ocr,
  sourceVisionConfigFingerprint: ChannelPlanInputSchema.shape.visionConfigFingerprint,
  labelText: ChannelLabelInputSchema.shape.text, visionConfigFingerprint: ChannelLabelInputSchema.shape.visionConfigFingerprint,
  evidencePolicy: ChannelLabelInputSchema.shape.evidencePolicy,
  labelQueues: ChannelSavedLabelWorkflowInputSchema.shape.queues, labelResources: ResourceGateSchema,
}).superRefine((c, ctx) => {
  const catalog = c.catalogResources.activities.readCatalogPage, product = c.productResources.activities.browserSession;
  if (!catalog?.some(n => n.resourceId === c.browserResource) || !product?.some(n => n.resourceId === c.browserResource))
    ctx.addIssue({ code: "custom", message: "Shared browser admission and label core queue required" });
});
export type AmazonLiveConfig = z.infer<typeof AmazonLiveConfigSchema>;
