import { loadConfig } from "@crawl-automation/platform";
import { WorkerConfigSchema, type WorkerConfig } from "./config.js";
import { checkWorkerResources } from "./resources/resource-check.js";
import { checkWorkerRoleSettings } from "./processes/role-settings.js";

/**
 * The worker's settings come from one private JSON file named by `V3_PIPELINE_CONFIG`. Not `V3_WORKER_CONFIG`: the
 * deployment control reads that variable as an old-style worker config and then also requires a role and build ID
 * in the health file, so the pipeline worker would never count as ready. Every permit is checked against the work it
 * guards before the worker starts.
 */
export async function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerConfig> {
  const config = await loadConfig(WorkerConfigSchema, env["V3_PIPELINE_CONFIG"] ?? "");
  checkWorkerResources(config);
  checkWorkerRoleSettings(config);
  return config;
}
