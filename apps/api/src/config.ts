import { DtcSettingsSchema } from "@crawl-automation/channel-dtc";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import {
  DeliveryRunnerOptionsSchema,
  EvidenceTestPrefixSchema,
  QueueDispatcherOptionsSchema,
} from "@crawl-automation/app";
import { ResourceKindsSchema } from "@crawl-automation/channels-core";
import { OcrApiSettingsSchema } from "@crawl-automation/processing";
import {
  DatabaseConfigSchema,
  LogConfigSchema,
  R2ScopeSchema,
  ScraperApiOptionChoicesSchema,
  TemporalConfigSchema,
  loadConfig,
} from "@crawl-automation/platform";
import {
  ChannelIdSchema,
  DeliveryTarget,
  ResourceGateSchema,
} from "@crawl-automation/v3-contracts";
import { COLLECTION_WORKFLOW, ProductPipelineInputSchema } from "@crawl-automation/workflows";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { BrandScanSettingsSchema } from "./brand-scan-config.js";
import { checkApiResources } from "./resources/resource-check.js";

const absolutePath = z.string().refine(isAbsolute, "Must be an absolute path");

/** Where a brand run's CollectionWorkflow starts; the old per-channel brand workflows are refused. */
const BrandRunTarget = DeliveryTarget.extend({ workflowType: z.literal(COLLECTION_WORKFLOW) });

export const ApiConfigSchema = z.strictObject({
  api: z.strictObject({
    /** Loopback, RFC 1918 or CGNAT; the API has no login, so never a public address. */
    host: z
      .string()
      .refine(
        (host) =>
          isIP(host) !== 0 &&
          ["loopback", "private", "carrierGradeNat"].includes(ipaddr.process(host).range()),
        "Must be a loopback, RFC 1918 or CGNAT IP address",
      ),
    port: z.number().int().min(1024).max(65535),
  }),
  log: LogConfigSchema.default({ level: "info" }),
  database: DatabaseConfigSchema,
  temporal: TemporalConfigSchema,
  delivery: z.strictObject({
    clusterId: z.string().min(1),
    channels: z.partialRecord(ChannelIdSchema, BrandRunTarget),
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
      channels: z.partialRecord(ChannelIdSchema, z.strictObject({ resources: ResourceGateSchema })),
    })
    .default({ queues: { activities: "none", plan: "none", label: "none" }, channels: {} }),
  /** Resource kinds checked against capture modes at startup; overrides the shared known kinds. */
  resourceKinds: ResourceKindsSchema.default({}),
  fleet: z
    .strictObject({
      /** Ignored compatibility keys; fleet.status never reads the old monitor or Amazon gate. */
      monitorStatus: absolutePath.optional(),
      queueHealth: absolutePath.optional(),
      /** Additional remote queues, including model/OCR queues absent from this API's routes. */
      taskQueues: z.array(z.string().min(1).max(200)).default([]),
      /** The same OCR API settings used by the processing workers. */
      ocrApi: z.looseObject({ baseUrl: z.url() }).pipe(OcrApiSettingsSchema).optional(),
    })
    .default({ taskQueues: [] }),
  /**
   * R2 access for Review reads and manual test captures. Reviews stay read-only; evidence.capture writes only
   * under evidence.testPrefix. Missing storage refuses both operations with their registered config errors.
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
   * Brand scans: listing pages through ScraperAPI, archived in R2. Without this section
   * scan requests answer BRAND_SCAN.NOT_CONFIGURED; brand-source import works either way. `ego` and `wholefoods`
   * together enable Whole Foods scans in the Ego browser (an owner-approved browser case).
   */
  brandScans: BrandScanSettingsSchema.optional(),
  /** The same browser-verified site list configured on the pipeline and browser workers. */
  browser: z.strictObject({ dtc: DtcSettingsSchema.default({ sites: [] }) }).optional(),
  /** Manual test captures use their own bucket-level tests/ prefix, never storage.r2.prefix. */
  evidence: z
    .strictObject({
      testPrefix: EvidenceTestPrefixSchema.optional(),
      /** Copy the normal product worker's capture settings; this does not enable a scan runner. */
      capture: BrandScanSettingsSchema.in
        .pick({ route: true, scraperApi: true })
        .extend({
          channels: z.partialRecord(ChannelIdSchema, ScraperApiOptionChoicesSchema).default({}),
        })
        .optional(),
    })
    .optional(),
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

/** Reads the private `V3_API_CONFIG` file and checks capture permits before the API starts. */
export async function loadApiConfig(env: NodeJS.ProcessEnv = process.env): Promise<ApiConfig> {
  const config = await loadConfig(ApiConfigSchema, env["V3_API_CONFIG"] ?? "");
  checkApiResources(config.pipeline.channels, config.resourceKinds);
  return config;
}
