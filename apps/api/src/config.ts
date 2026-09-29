import { isAbsolute } from "node:path";
import { DeliveryRunnerOptionsSchema, QueueDispatcherOptionsSchema } from "@crawl-automation/app";
import {
  DatabaseConfigSchema,
  LogConfigSchema,
  TemporalConfigSchema,
  loadConfig,
} from "@crawl-automation/platform";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { DeliveryTarget, ResourceGateSchema } from "@crawl-automation/v3-contracts";
import { ProductPipelineInputSchema } from "@crawl-automation/workflows";
import { z } from "zod";
import { BrandScanSettingsSchema } from "./brand-scan-config.js";

const absolutePath = z.string().refine(isAbsolute, "Must be an absolute path");

export const ApiConfigSchema = z.strictObject({
  api: z.strictObject({
    /** A loopback or Tailscale address; the API has no login, so never a public one. */
    host: z.string().regex(/^(127|100)(\.\d{1,3}){3}$/),
    port: z.number().int().min(1024).max(65535),
  }),
  log: LogConfigSchema.default({ level: "info" }),
  database: DatabaseConfigSchema,
  temporal: TemporalConfigSchema,
  delivery: z.strictObject({
    clusterId: z.string().min(1),
    channels: z.partialRecord(z.enum(["amazon", "gnc", "swanson", "dtc"]), DeliveryTarget),
    /** While this file exists, no new run is started. */
    pauseFile: absolutePath,
    runner: DeliveryRunnerOptionsSchema.default({
      batchSize: 20,
      concurrency: 4,
      intervalMs: 1_000,
    }),
  }),
  /** Product runs: the pipeline's task queues, and the permits each channel's capture takes. */
  pipeline: z
    .strictObject({
      queues: ProductPipelineInputSchema.shape.queues,
      channels: z.partialRecord(
        z.enum(["amazon", "gnc", "swanson", "dtc"]),
        z.strictObject({ resources: ResourceGateSchema }),
      ),
    })
    .default({ queues: { activities: "none", plan: "none", label: "none" }, channels: {} }),
  fleet: z.strictObject({ monitorStatus: absolutePath, queueHealth: absolutePath }),
  /**
   * Read-only access to the evidence in R2, for the Review evidence and recheck procedures. Without it those
   * procedures answer REVIEW.EVIDENCE_NOT_CONFIGURED; nothing else needs it.
   */
  storage: z
    .strictObject({
      r2: R2ScopeSchema,
      r2Credentials: z.strictObject({
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
      }),
      /** The storage ID results were stored under (the workers' `storageId`). */
      storageId: z.string().min(1),
    })
    .optional(),
  /**
   * Brand scans: listing pages through ScraperAPI, archived in R2 (written, unlike `storage`). Without this section
   * scan requests answer BRAND_SCAN.NOT_CONFIGURED; brand-source import works either way. `ego` and `wholefoods`
   * together enable Whole Foods scans in the Ego browser (an owner-approved browser case).
   */
  brandScans: BrandScanSettingsSchema.optional(),
  /** The product queue of every channel but Amazon: how often its dispatcher runs a round. */
  queue: z
    .strictObject({ dispatcher: QueueDispatcherOptionsSchema.default({ intervalMs: 5_000 }) })
    .default({ dispatcher: { intervalMs: 5_000 } }),
  /** How often ended work is checked: permits of stopped owners released, ended runs settled. */
  cleanup: z.strictObject({ intervalMs: z.number().int().min(10_000).max(3_600_000) }).default({
    intervalMs: 60_000,
  }),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

/** The API's settings come from one private JSON file named by `V3_API_CONFIG`. */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): Promise<ApiConfig> {
  return loadConfig(ApiConfigSchema, env["V3_API_CONFIG"] ?? "");
}
