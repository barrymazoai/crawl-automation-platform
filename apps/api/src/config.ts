import { isAbsolute } from "node:path";
import { DeliveryRunnerOptionsSchema } from "@crawl-automation/app";
import {
  DatabaseConfigSchema,
  LogConfigSchema,
  TemporalConfigSchema,
  loadConfig,
} from "@crawl-automation/platform";
import { DeliveryTarget } from "@crawl-automation/v3-contracts";
import { z } from "zod";

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
  fleet: z.strictObject({ monitorStatus: absolutePath, queueHealth: absolutePath }),
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
