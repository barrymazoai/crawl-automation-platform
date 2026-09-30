import { createLogger, startHeartbeat } from "@crawl-automation/platform";
import { runWorkers } from "@crawl-automation/platform/temporal-worker";
import { loadWorkerConfig } from "./load-config.js";
import { buildContainer } from "./container.js";
import { roleWorkers } from "./processes/role-workers.js";
import { selectProcess } from "./processes/select-process.js";

/** Reports health when the deployment names a health file (`V3_WORKER_HEALTH_FILE`, set by launchd). */
async function heartbeat(name: string) {
  const path = process.env["V3_WORKER_HEALTH_FILE"];
  return path ? startHeartbeat(path, `${name}-worker`) : { stop: async () => undefined };
}

/**
 * Runs one of the machine's worker processes (`V3_WORKER_PROCESS`; the pipeline when unset): every role the config
 * groups into it, one Temporal worker per role, until SIGTERM or SIGINT.
 */
async function main(): Promise<void> {
  const config = await loadWorkerConfig();
  const chosen = selectProcess(config, process.env["V3_WORKER_PROCESS"]);
  const container = await buildContainer(config);
  const { log, database, r2 } = container.cradle;
  const worker = await runWorkers(config.temporal, roleWorkers(chosen.roles, container.cradle));
  const health = await heartbeat(chosen.name);
  const queues = chosen.roles.map((entry) => `${entry.role}:${entry.taskQueue}`);
  log.info({ process: chosen.name, queues }, "worker process running");
  process.once("SIGTERM", () => worker.shutdown());
  process.once("SIGINT", () => worker.shutdown());
  await worker.done;

  log.info({ process: chosen.name }, "worker process stopping");
  await health.stop();
  r2.close();
  await database.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    createLogger({ name: "worker", destination: process.stderr }).fatal(
      { err: String(error) },
      "worker process failed",
    );
    process.exit(1);
  },
);
