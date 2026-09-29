import { isAbsolute } from "node:path";
import type { LabelSettings } from "@crawl-automation/app";
import {
  DatabaseConfigSchema,
  LogConfigSchema,
  TemporalConfigSchema,
  loadConfig,
} from "@crawl-automation/platform";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import {
  ChannelLabelInputSchema,
  ChannelPlanInputSchema,
  ChannelSavedLabelWorkflowInputSchema,
  ResourceGateSchema,
  ScraperApiRouteSchema,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute, "Must be an absolute path");

export const WorkerConfigSchema = z.strictObject({
  log: LogConfigSchema.default({ level: "info" }),
  database: DatabaseConfigSchema,
  temporal: TemporalConfigSchema,
  /** Names this Temporal cluster in the execution records. */
  clusterId: z.string().min(1),
  /** The pipeline's task queue: the product workflow and its activities both run here. */
  taskQueue: z.string().min(1).max(200),
  maxConcurrentActivities: z.number().int().min(1).max(64).default(4),
  /**
   * How long the deployment control waits for this worker's first heartbeat when starting it (it reads this field).
   * Loading the workflow bundle takes about a minute, longer than its default wait.
   */
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
  /** Product pages as static HTML through ScraperAPI; the key stays in this private file. */
  capture: z.strictObject({
    route: ScraperApiRouteSchema,
    scraperApi: z.strictObject({
      apiKey: z.string().min(8).max(512),
      allowedOrigins: z.array(z.url()).min(1).max(32),
    }),
  }),
  /** How image hosts are resolved: pinned by this worker (`direct`) or by the system (`system`). */
  files: z.strictObject({ resolve: z.enum(["direct", "system"]) }).default({ resolve: "direct" }),
  /** The formula planner's model settings for the sources it plans. */
  plan: z.strictObject({
    text: ChannelPlanInputSchema.shape.text,
    ocr: ChannelPlanInputSchema.shape.ocr,
    visionConfigFingerprint: ChannelPlanInputSchema.shape.visionConfigFingerprint,
    factsPolicy: z.literal("text-facts-first/1").optional(),
  }),
  /** The label workflow's model settings, its task queues and its permits. */
  label: z.strictObject({
    text: ChannelLabelInputSchema.shape.text,
    visionConfigFingerprint: ChannelLabelInputSchema.shape.visionConfigFingerprint,
    evidencePolicy: ChannelLabelInputSchema.shape.evidencePolicy,
    queues: ChannelSavedLabelWorkflowInputSchema.shape.queues,
    resources: ResourceGateSchema,
  }) satisfies z.ZodType<LabelSettings>,
});
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/** The worker's settings come from one private JSON file named by `V3_WORKER_CONFIG`. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): Promise<WorkerConfig> {
  return loadConfig(WorkerConfigSchema, env["V3_WORKER_CONFIG"] ?? "");
}
