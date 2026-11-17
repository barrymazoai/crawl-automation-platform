import { ApiBrandEnrichmentSchema } from "./brand-enrichment-parts.js";
import { DtcSettingsSchema } from "@crawl-automation/channel-dtc";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import {
  validateBrandEnrichmentSettings,
  DeliveryRunnerOptionsSchema,
  EvidenceTestPrefixSchema,
  QueueDispatcherOptionsSchema,
  ScanAdmissionSettingsSchema,
} from "@crawl-automation/app";
import { ResourceKindsSchema } from "@crawl-automation/channels-core";
import { OcrApiSettingsSchema } from "@crawl-automation/processing";
import {
  DatabaseConfigSchema,
  JOURNAL_HTML_PREFIXES,
  LogConfigSchema,
  R2ScopeSchema,
  ScraperApiOptionChoicesSchema,
  TemporalConfigSchema,
  loadConfig,
} from "@crawl-automation/platform";
import {
  SiteAnalysisLimitsSchema,
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

export const ApiConfigSchema = z
  .strictObject({
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
    database: DatabaseConfigSchema.refine((config) => config.maxConnections >= 2, {
      message: "Stop verification needs one lock connection and one journal connection",
    }),
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
        channels: z.partialRecord(
          ChannelIdSchema,
          z.strictObject({ resources: ResourceGateSchema }),
        ),
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
     * scan requests answer BRAND_SCAN.NOT_CONFIGURED; brand-source import works either way.
     * Whole Foods defaults to HTTP; its mode and browserQueue select the retained browser fallback.
     */
    brandScans: BrandScanSettingsSchema.optional(),
    siteAnalysis: SiteAnalysisLimitsSchema.optional(),
    brandEnrichment: ApiBrandEnrichmentSchema.optional(),
    /** The same browser-verified site list configured on the pipeline and browser workers. */
    browser: z.strictObject({ dtc: DtcSettingsSchema.default({ sites: [] }) }).optional(),
    /** Manual test captures use their own bucket-level tests/ prefix, never storage.r2.prefix. */
    evidence: z
      .strictObject({
        testPrefix: EvidenceTestPrefixSchema.optional(),
        /** Copy the normal product worker's capture settings; this does not enable a scan runner. */
        capture: BrandScanSettingsSchema.out
          .pick({ route: true, scraperApi: true })
          .extend({
            channels: z.partialRecord(ChannelIdSchema, ScraperApiOptionChoicesSchema).default({}),
          })
          .optional(),
      })
      .optional(),
    /** Shared queue dispatch and the recent-terminal window for brand discoveries on every channel. */
    queue: ScanAdmissionSettingsSchema.extend({
      dispatcher: QueueDispatcherOptionsSchema.default({ intervalMs: 5_000 }),
    }).prefault({}),
    /** How often ended work is checked: permits of stopped owners released, ended runs settled. */
    cleanup: z.strictObject({ intervalMs: z.number().int().min(10_000).max(3_600_000) }).default({
      intervalMs: 60_000,
    }),
    /**
     * This machine's copies of original pages, removed once R2 holds the same bytes (owner 2026-10-19). Needs
     * `storage` (the workers' R2 scope) and runs only where the API shares the workers' disk (Server 一).
     * Owner 2026-10-21: every hour, leaving folders written in the last two hours alone, so the copies never
     * fill the disk between runs.
     */
    journalPrune: z
      .strictObject({
        /** The workers' `storage.journalRoot`. */
        root: absolutePath,
        prefixes: z
          .array(z.string().min(1))
          .min(1)
          .default([...JOURNAL_HTML_PREFIXES]),
        /** A product folder with any write younger than this stays whole. */
        minAgeHours: z.number().int().min(1).max(720).default(2),
        /**
         * Minutes between scheduled prunes, aligned to midnight UTC (60 = every full hour); null runs only when
         * started through the API.
         */
        intervalMinutes: z.number().int().min(5).max(1440).nullable().default(60),
        /**
         * Owner 2026-11-15: the workers' copies cache (`storage.cacheRoot`) is pruned in the same run; a copy last
         * written more than `maxAgeHours` ago goes and is read from R2 again when needed. Absent: not pruned.
         */
        cache: z
          .strictObject({
            root: absolutePath,
            maxAgeHours: z.number().int().min(1).max(720).default(48),
          })
          .optional(),
        /**
         * Owner 2026-11-17: per-step timing (`activity`) and reuse (`preparation`) rows of `usage_event` are kept
         * seven days and removed in the same run, at most `maxRowsPerRun` a run. Cost rows cannot be named here and
         * are kept. Absent: nothing is removed.
         */
        usage: z
          .strictObject({
            kinds: z
              .array(z.enum(["activity", "preparation"]))
              .min(1)
              .default(["activity", "preparation"]),
            // The database refuses removing such a row younger than seven days (078).
            keepDays: z.number().int().min(7).max(365).default(7),
            maxRowsPerRun: z.number().int().min(1).max(5_000_000).default(500_000),
          })
          .optional(),
      })
      .optional(),
  })
  .superRefine(validateBrandEnrichmentSettings)
  .refine((config) => !config.journalPrune || config.storage, {
    message: "journalPrune needs storage (R2) to check each copy",
    path: ["journalPrune"],
  });
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

/** Reads the private `V3_API_CONFIG` file and checks capture permits before the API starts. */
export async function loadApiConfig(env: NodeJS.ProcessEnv = process.env): Promise<ApiConfig> {
  const config = await loadConfig(ApiConfigSchema, env["V3_API_CONFIG"] ?? "");
  checkApiResources(config.pipeline.channels, config.resourceKinds);
  return config;
}
