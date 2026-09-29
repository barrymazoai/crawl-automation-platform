import type { WorkerConfig } from "../config.js";
import { DEFAULT_PROCESS, type ProcessRole } from "./process-config.js";
import { processErrors } from "./process-errors.js";

export interface SelectedProcess {
  name: string;
  roles: ProcessRole[];
}

/**
 * The roles of the process this worker was started as (`V3_WORKER_PROCESS`). A config without processes has one:
 * the pipeline on its task queue, so the configs written on 2026-09-29 keep running unchanged.
 */
export function selectProcess(
  config: WorkerConfig,
  requested: string | undefined,
): SelectedProcess {
  const name = requested ?? DEFAULT_PROCESS;
  if (config.processes) {
    const chosen = config.processes[name];
    if (!chosen) {
      throw processErrors.create("WORKER.UNKNOWN_PROCESS", {
        details: { process: name, known: Object.keys(config.processes) },
      });
    }
    return { name, roles: chosen.roles };
  }
  if (name !== DEFAULT_PROCESS || !config.taskQueue) {
    throw processErrors.create("WORKER.UNKNOWN_PROCESS", { details: { process: name } });
  }
  const pipeline = {
    role: "pipeline" as const,
    taskQueue: config.taskQueue,
    maxConcurrentActivities: config.maxConcurrentActivities,
  };
  return { name, roles: [pipeline] };
}
