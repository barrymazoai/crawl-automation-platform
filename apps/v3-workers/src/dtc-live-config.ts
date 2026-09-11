import { DtcSitePolicySchema } from "@crawl-automation/v3-contracts";
import { CodexExecutionConfigSchema } from "@crawl-automation/v3-codex";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { CatalogScopeSchema, ChannelPlanInputSchema, ChannelLabelInputSchema, ChannelSavedLabelWorkflowInputSchema,
  DtcProductJobSchema, ResourceGateSchema, VersionTagSchema } from "@crawl-automation/v3-contracts";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { CdpTaskConfigSchema } from "@crawl-automation/v3-acquisition";
const DtcConfigFields = {
  clusterId: VersionTagSchema,
  database: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }),
  resourceDatabase: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }).optional(),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  journalRoot: z.string().refine(isAbsolute), pageJournalRoot: z.string().refine(isAbsolute), cacheRoot: z.string().refine(isAbsolute),
  browser: CdpTaskConfigSchema, browserResource: VersionTagSchema, egressId: VersionTagSchema,
  scope: CatalogScopeSchema.refine(s => s.channel === "dtc"), brandName: z.string().min(1).max(1000),
  catalogQueue: VersionTagSchema, catalogQueues: z.strictObject({ source: VersionTagSchema, ledger: VersionTagSchema, product: VersionTagSchema }),
  catalogResources: ResourceGateSchema,
  site: DtcSitePolicySchema, browserModelResource: VersionTagSchema, codex: CodexExecutionConfigSchema.optional(),
  maxPages: z.number().int().min(1).max(10).optional(),
  productQueues: DtcProductJobSchema.shape.queues, productResources: ResourceGateSchema,
  sourceText: ChannelPlanInputSchema.shape.text, ocr: ChannelPlanInputSchema.shape.ocr,
  sourceVisionConfigFingerprint: ChannelPlanInputSchema.shape.visionConfigFingerprint,
  labelText: ChannelLabelInputSchema.shape.text, visionConfigFingerprint: ChannelLabelInputSchema.shape.visionConfigFingerprint,
  evidencePolicy: ChannelLabelInputSchema.shape.evidencePolicy,
  labelQueues: ChannelSavedLabelWorkflowInputSchema.shape.queues, labelResources: ResourceGateSchema,
  nodeControl: z.strictObject({nodeId:VersionTagSchema,workflowQueue:VersionTagSchema,activityQueue:VersionTagSchema}),
};
const {database: _database, resourceDatabase: _resourceDatabase, ...browserFields}=DtcConfigFields;
// Windows is deliberately unable to parse a configuration carrying DB credentials.
export const DtcBrowserConfigSchema=z.strictObject(browserFields).superRefine(validate);
export const DtcLiveConfigSchema=z.strictObject(DtcConfigFields).superRefine(validate);
function validate(c:z.infer<ReturnType<typeof z.strictObject<typeof browserFields>>>,ctx:z.RefinementCtx) {
  if(c.brandName!==c.site.brandName||c.scope.rootUrl!==c.site.catalogPages[0]||new URL(c.scope.rootUrl).origin!==c.site.origin)
    ctx.addIssue({code:"custom",message:"DTC site, brand and source must match"});
  const catalog = c.catalogResources.activities.readCatalogPage, product = c.productResources.activities.browserSession;
  if (!c.productResources.activities.captureDtcProduct?.some(n=>n.resourceId===c.browserModelResource) || !catalog?.some(n=>n.resourceId===c.browserModelResource) || !catalog?.some(n => n.resourceId === c.browserResource) || !product?.some(n => n.resourceId === c.browserResource))
    ctx.addIssue({ code: "custom", message: "Shared browser admission and label core queue required" });
}
export type DtcLiveConfig = z.infer<typeof DtcLiveConfigSchema>;
export type DtcBrowserConfig = z.infer<typeof DtcBrowserConfigSchema>;
