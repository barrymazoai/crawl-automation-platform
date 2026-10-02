import { isAbsolute } from "node:path";
import type { LabelSettings } from "@crawl-automation/app";
import {
  HTML_REUSE_WINDOW_MS,
  ListingFetchSettingsSchema,
  ResourceKindsSchema,
} from "@crawl-automation/channels-core";
import {
  DatabaseConfigSchema,
  LogConfigSchema,
  ScraperApiAccessSchema,
  TemporalConfigSchema,
} from "@crawl-automation/platform";
import { R2ScopeSchema } from "@crawl-automation/platform";
import {
  ChannelLabelInputSchema,
  ChannelPlanInputSchema,
  ChannelSavedLabelWorkflowInputSchema,
  LabelSourcePolicySchema,
  ResourceGateSchema,
  ScraperApiRouteSchema,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { WholeFoodsHttpScanSettingsSchema } from "@crawl-automation/channels-wholefoods";
import { SwansonBrandScanSettingsSchema } from "@crawl-automation/channel-swanson";
import { CaptureChannelSettingsSchema } from "./capture-channel-settings.js";
import { BrowserSettingsSchema } from "./browser/browser-settings.js";
import { validateBrowserWorker } from "./browser/browser-worker-config.js";
import { ProcessingSettingsSchema } from "./label/processing-settings.js";
import { WorkerProcessesSchema } from "./processes/process-config.js";
import { ResourceHealthConfigSchema } from "./resources/resource-health-config.js";

const absolutePath = z.string().refine(isAbsolute, "Must be an absolute path");

/** New label work reads labels with this protocol only; older versions stay readable for stored answers. */
export const LABEL_TEXT_POLICY = "label-text/5";

export const WorkerConfigSchema = z
  .strictObject({
    log: LogConfigSchema.default({ level: "info" }),
    database: DatabaseConfigSchema,
    temporal: TemporalConfigSchema,
    /** Names this Temporal cluster in the execution records. */
    clusterId: z.string().min(1),
    /**
     * The processes this machine runs and the roles each groups (see `processes/process-config.ts`); the process a
     * started worker runs is named by `V3_WORKER_PROCESS`. Configs written before processes existed leave this out and
     * name the pipeline's task queue below instead.
     */
    processes: WorkerProcessesSchema.optional(),
    /** Without `processes`: the pipeline's task queue (the product workflow and its activities). */
    taskQueue: z.string().min(1).max(200).optional(),
    maxConcurrentActivities: z.number().int().min(1).max(64).default(4),
    /** Unused; kept so configs written on 2026-09-29 stay valid. */
    startupTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    storage: z.strictObject({
      r2: R2ScopeSchema,
      r2Credentials: z.strictObject({
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
      }),
      /** This machine's copy of evidence written before R2 confirms it. */
      journalRoot: absolutePath,
      /** Local copies of R2 evidence already read. */
      cacheRoot: absolutePath,
    }),
    /** Required by pipeline only; browser-only machines need no ScraperAPI key. */
    capture: z
      .strictObject({
        /** The route's name, egress and default options (country, session; `rendered-html` means render). */
        route: ScraperApiRouteSchema.refine((route) => route.responseMode !== "binary", {
          message: "Product pages are HTML",
        }),
        scraperApi: ScraperApiAccessSchema,
        /** A channel's own ScraperAPI options over the route's, e.g. `{ "gnc": { "premium": true } }`. */
        channels: CaptureChannelSettingsSchema,
        /** How long a saved product page is reused instead of a new paid download (default 7 days). */
        htmlReuseHours: z
          .number()
          .int()
          .min(1)
          .max(90 * 24)
          .default(HTML_REUSE_WINDOW_MS / 3_600_000),
      })
      .optional(),
    /** How image hosts are resolved: pinned by this worker (`direct`) or by the system (`system`). */
    files: z.strictObject({ resolve: z.enum(["direct", "system"]) }).default({ resolve: "direct" }),
    /** Required by pipeline and browser product capture (including DTC source plans). */
    plan: z
      .strictObject({
        text: ChannelPlanInputSchema.shape.text,
        ocr: ChannelPlanInputSchema.shape.ocr,
        visionConfigFingerprint: ChannelPlanInputSchema.shape.visionConfigFingerprint,
        factsPolicy: z.literal("text-facts-first/1").optional(),
        /** Per-channel order for new plans; Whole Foods formulas use Amazon's order. */
        sourceOrder: z
          .partialRecord(
            z.enum(["amazon", "gnc", "swanson", "costco", "dtc"]),
            LabelSourcePolicySchema.shape.order,
          )
          .default({}),
      })
      .optional(),
    /** Required by pipeline to hand off label work; label execution roles use processing. */
    label: (
      z.strictObject({
        text: ChannelLabelInputSchema.shape.text.refine(
          (text) => text.policyVersion === LABEL_TEXT_POLICY,
          { message: `New label work uses ${LABEL_TEXT_POLICY} only`, path: ["policyVersion"] },
        ),
        visionConfigFingerprint: ChannelLabelInputSchema.shape.visionConfigFingerprint,
        evidencePolicy: ChannelLabelInputSchema.shape.evidencePolicy,
        queues: ChannelSavedLabelWorkflowInputSchema.shape.queues,
        resources: ResourceGateSchema,
        /** The shared Label workflow's three task queues and its permits (model and OCR calls). */
        shared: z
          .strictObject({
            queues: z.strictObject({
              activities: z.string().min(1).max(200),
              ocr: z.string().min(1).max(200),
              model: z.string().min(1).max(200),
            }),
            resources: ResourceGateSchema.optional(),
          })
          .optional(),
      }) satisfies z.ZodType<LabelSettings>
    ).optional(),
    /** The label steps on this machine: storage, node name, Codex and the OCR API (see `label/processing-settings.ts`). */
    processing: ProcessingSettingsSchema.optional(),
    /**
     * The browser worker on each Mac mini with Ego serves DTC and Amazon Store-page brands.
     * Whole Foods can explicitly use this fallback; see `browser/browser-settings.ts`.
     */
    browser: BrowserSettingsSchema.optional(),
    /**
     * The kind of each resource the permits name (browser, http-lane, model, ocr, cpu…), checked against the work at
     * startup. Today's resources are known already (`resources/known-kinds.ts`); a new resource is named here.
     */
    resourceKinds: ResourceKindsSchema.default({}),
    /** Refreshed only by the process hosting the resources role. */
    resourceHealth: ResourceHealthConfigSchema.optional(),
    /** Listing-only route/options for permit-gated HTTP brand scans; uses storage.r2 for originals. */
    brandScans: ListingFetchSettingsSchema.extend({
      swanson: SwansonBrandScanSettingsSchema.optional(),
      wholefoods: WholeFoodsHttpScanSettingsSchema.prefault({}),
    }).optional(),
  })
  .refine((config) => config.processes !== undefined || config.taskQueue !== undefined, {
    message: "Name the processes, or the pipeline's task queue",
  })
  .superRefine(validateBrowserWorker);
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
