import { isAbsolute } from "node:path";
import { z } from "zod";
import { NetworkRouteSchema } from "@crawl-automation/v3-contracts";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { EgoBrowserConfigSchema } from "@crawl-automation/v3-acquisition";
export const LiveGncConfig=z.strictObject({database:z.strictObject({connectionString:z.string().min(1),tls:z.boolean()}),
  journalRoot:z.string().refine(isAbsolute),pageJournalRoot:z.string().refine(isAbsolute),cacheRoot:z.string().refine(isAbsolute),r2:R2ScopeSchema,r2Credentials:z.strictObject({accessKeyId:z.string().min(1),secretAccessKey:z.string().min(1)}),
  browser:EgoBrowserConfigSchema,browserResource:z.string().min(1),network:NetworkRouteSchema.refine(n=>n.mode==="host"),allowedImageOrigins:z.array(z.url()).min(1).max(10)});
