import { z } from "zod";
import { CatalogPageInputSchema, GncAcquireInputSchema, GncStreamingLabelWorkflowInputSchema, GncCatalogProductPolicySchema, ExecutionIdSchema, VersionTagSchema } from "@crawl-automation/v3-contracts";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
export const CatalogDatabaseConfig = z.strictObject({ database: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }) });
export const CatalogSourceConfig = CatalogDatabaseConfig.extend({ journalRoot: z.string().min(1), r2: R2ScopeSchema,
  r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  grants: z.array(z.strictObject({ input: CatalogPageInputSchema, capture: GncAcquireInputSchema })).max(1000) });
export const CatalogProductConfig = CatalogDatabaseConfig.extend({ clusterId: ExecutionIdSchema,
  products: z.array(z.strictObject({ discoveryId: ExecutionIdSchema, input: GncStreamingLabelWorkflowInputSchema, queue: VersionTagSchema })).max(1000).default([]),
  factories: z.array(GncCatalogProductPolicySchema).max(100).default([]) });
