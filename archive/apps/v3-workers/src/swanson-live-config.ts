import { isAbsolute } from "node:path";
import { z } from "zod";
import { CatalogScopeSchema, ChannelPlanInputSchema, ChannelLabelInputSchema, ChannelSavedLabelWorkflowInputSchema,
  SwansonProductJobSchema, ResourceGateSchema, VersionTagSchema, ScraperApiRouteSchema } from "@crawl-automation/v3-contracts";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { EgoTaskSpaceSchema } from "@crawl-automation/v3-acquisition";
import { SwansonProductListSchema } from "./swanson-link-catalog.js";
// browser (default): an owned Ego task space. scraperapi: product pages as static HTML through the provider route,
// archived in R2 before parsing; images (only when the facts text is incomplete) straight from the image CDN.
export const SwansonCaptureConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("browser") }),
  z.strictObject({ mode: z.literal("scraperapi"), route: ScraperApiRouteSchema,
    scraperApi: z.strictObject({ apiKey: z.string().min(8).max(512).regex(/^[A-Za-z0-9_-]+$/), allowedOrigins: z.array(z.string().url()).min(1).max(32) }),
    dns: z.enum(["system", "doh", "none"]).default("system") }),
]);
export const SwansonLiveConfigSchema = z.strictObject({
  clusterId: VersionTagSchema,
  database: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }),
  resourceDatabase: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }).optional(),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  journalRoot: z.string().refine(isAbsolute), pageJournalRoot: z.string().refine(isAbsolute), cacheRoot: z.string().refine(isAbsolute),
  capture: SwansonCaptureConfigSchema.default({ mode: "browser" }),
  browser: EgoTaskSpaceSchema.optional(), browserResource: VersionTagSchema, egressId: VersionTagSchema,
  // text-facts-first/1: complete facts text on the product page is the only formula source (no images, OCR, vision).
  factsPolicy: z.literal("text-facts-first/1").optional(),
  // A given product list replaces the Ego brand-grid read for its catalog request (e.g. products.json scan results).
  productList: SwansonProductListSchema.optional(),
  scope: CatalogScopeSchema.refine(s => s.channel === "swanson"), brandName: z.string().min(1).max(1000),
  catalogQueue: VersionTagSchema, catalogQueues: z.strictObject({ source: VersionTagSchema, ledger: VersionTagSchema, product: VersionTagSchema }),
  catalogResources: ResourceGateSchema,
  maxPages: z.number().int().min(1).max(10).optional(),
  productQueues: SwansonProductJobSchema.shape.queues, productResources: ResourceGateSchema,
  sourceText: ChannelPlanInputSchema.shape.text, ocr: ChannelPlanInputSchema.shape.ocr,
  sourceVisionConfigFingerprint: ChannelPlanInputSchema.shape.visionConfigFingerprint,
  labelText: ChannelLabelInputSchema.shape.text, visionConfigFingerprint: ChannelLabelInputSchema.shape.visionConfigFingerprint,
  evidencePolicy: ChannelLabelInputSchema.shape.evidencePolicy,
  labelQueues: ChannelSavedLabelWorkflowInputSchema.shape.queues, labelResources: ResourceGateSchema,
}).superRefine((c, ctx) => {
  const catalog = c.catalogResources.activities.readCatalogPage, product = c.productResources.activities.browserSession;
  if (!catalog?.some(n => n.resourceId === c.browserResource) || !product?.some(n => n.resourceId === c.browserResource) || !c.labelQueues.core)
    ctx.addIssue({ code: "custom", message: "Shared browser admission and label core queue required" });
  if (c.capture.mode === "browser" && !c.browser) ctx.addIssue({ code: "custom", message: "Browser capture requires an owned browser task space" });
  if (c.capture.mode === "scraperapi") {
    if (c.capture.route.responseMode !== "html") ctx.addIssue({ code: "custom", message: "ScraperAPI capture reads static HTML only" });
    if (!c.capture.scraperApi.allowedOrigins.includes("https://www.swansonvitamins.com")) ctx.addIssue({ code: "custom", message: "ScraperAPI route must allow https://www.swansonvitamins.com" });
    if (!c.productList) ctx.addIssue({ code: "custom", message: "ScraperAPI capture takes its products from a product list (no browser brand grid)" });
  }
});
export type SwansonLiveConfig = z.infer<typeof SwansonLiveConfigSchema>;
