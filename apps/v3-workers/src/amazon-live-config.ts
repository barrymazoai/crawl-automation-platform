import { isAbsolute } from "node:path";
import { z } from "zod";
import { CatalogScopeSchema, ChannelPlanInputSchema, ChannelLabelInputSchema, ChannelSavedLabelWorkflowInputSchema,
  AmazonProductJobSchema, ResourceGateSchema, VersionTagSchema, ScraperApiRouteSchema } from "@crawl-automation/v3-contracts";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { EgoTaskSpaceSchema } from "@crawl-automation/v3-acquisition";
import { AmazonLinkBatchesSchema } from "./amazon-link-batches.js";
export const AmazonCaptureConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("browser") }),
  z.strictObject({ mode: z.literal("scraperapi"), route: ScraperApiRouteSchema,
    scraperApi: z.strictObject({ apiKey: z.string().min(8).max(512).regex(/^[A-Za-z0-9_-]+$/), allowedOrigins: z.array(z.string().url()).min(1).max(32) }),
    images: z.literal("direct").default("direct") }),
]);
export type AmazonCaptureConfig = z.infer<typeof AmazonCaptureConfigSchema>;
export const AmazonLiveConfigSchema = z.strictObject({
  clusterId: VersionTagSchema,
  database: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }),
  resourceDatabase: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }).optional(),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  journalRoot: z.string().refine(isAbsolute), pageJournalRoot: z.string().refine(isAbsolute), cacheRoot: z.string().refine(isAbsolute),
  // browser mode: an owned Ego task space. scraperapi mode: static HTML through the provider route, originals
  // straight from the image CDN. `browserResource` is the admission lane in both modes (a browser or a provider lane).
  capture: AmazonCaptureConfigSchema.default({ mode: "browser" }),
  browser: EgoTaskSpaceSchema.optional(), browserResource: VersionTagSchema, egressId: VersionTagSchema,
  scope: CatalogScopeSchema.refine(s => s.channel === "amazon"), brandName: z.string().min(1).max(1000),
  catalogQueue: VersionTagSchema, catalogQueues: z.strictObject({ source: VersionTagSchema, ledger: VersionTagSchema, product: VersionTagSchema }),
  catalogResources: ResourceGateSchema,
  catalogPages: z.array(z.string().url()).min(1).max(10), selectedAsins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).min(1).max(100).nullable(),
  maxPages: z.number().int().min(1).max(10).optional(),
  linkBatches: AmazonLinkBatchesSchema.optional(),
  deliveryPostalCode: z.string().regex(/^\d{5}$/).optional(),
  productQueues: AmazonProductJobSchema.shape.queues, productResources: ResourceGateSchema,
  sourceText: ChannelPlanInputSchema.shape.text, ocr: ChannelPlanInputSchema.shape.ocr,
  sourceVisionConfigFingerprint: ChannelPlanInputSchema.shape.visionConfigFingerprint,
  labelText: ChannelLabelInputSchema.shape.text, visionConfigFingerprint: ChannelLabelInputSchema.shape.visionConfigFingerprint,
  evidencePolicy: ChannelLabelInputSchema.shape.evidencePolicy,
  labelQueues: ChannelSavedLabelWorkflowInputSchema.shape.queues, labelResources: ResourceGateSchema,
}).superRefine((c, ctx) => { for (const message of amazonCaptureIssues(c)) ctx.addIssue({ code: "custom", message }); });
/** Pure config rules shared by the schema and tests. */
export function amazonCaptureIssues(c: { capture: AmazonCaptureConfig; browser?: unknown; browserResource: string; egressId: string; deliveryPostalCode?: string | undefined;
  catalogResources: { activities: Record<string, { resourceId: string }[]> }; productResources: { activities: Record<string, { resourceId: string }[]> } }): string[] {
  const issues: string[] = [], product = c.productResources.activities.browserSession, catalog = c.catalogResources.activities.readCatalogPage;
  if (!product?.some(n => n.resourceId === c.browserResource)) issues.push("Product admission must include the capture lane resource");
  if (c.capture.mode === "browser") {
    if (!c.browser) issues.push("Browser capture requires an owned browser task space");
    if (!catalog?.some(n => n.resourceId === c.browserResource)) issues.push("Shared browser admission and label core queue required");
  } else {
    if (c.capture.route.responseMode !== "html") issues.push("ScraperAPI capture reads static HTML only");
    if (c.deliveryPostalCode !== undefined) issues.push("ScraperAPI capture cannot pin a delivery postal code");
    if (c.capture.images === "direct" && c.egressId !== "direct/1") issues.push("Direct image downloads require egressId direct/1");
    if (!c.capture.scraperApi.allowedOrigins.includes("https://www.amazon.com")) issues.push("ScraperAPI route must allow https://www.amazon.com");
  }
  return issues;
}
export type AmazonLiveConfig = z.infer<typeof AmazonLiveConfigSchema>;
