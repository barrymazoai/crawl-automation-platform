import { runStopSweep } from "../resources/stop-sweep.js";
import { startHeartbeat } from "@crawl-automation/platform";
import { runWorkers, type RunningWorker } from "@crawl-automation/platform/temporal-worker";
import type { WorkerParts } from "../container.js";
import { roleWorkers } from "./role-workers.js";
import type { SelectedProcess } from "./select-process.js";

/** The health loop has exactly the lifetime of the worker process hosting resource activities. */
export async function runProcess(chosen: SelectedProcess, parts: WorkerParts): Promise<void> {
  const worker = await runWorkers(parts.config.temporal, roleWorkers(chosen.roles, parts));
  const controller = new AbortController();
  const shutdown = () => {
    controller.abort();
    worker.shutdown();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await runWithHealth({ chosen, parts, worker, signal: controller.signal, shutdown });
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    // The original error is propagated above; still wait for Temporal's shutdown before closing storage.
    await Promise.allSettled([worker.done]);
  }
}

async function runWithHealth(context: {
  chosen: SelectedProcess;
  parts: WorkerParts;
  worker: RunningWorker;
  signal: AbortSignal;
  shutdown(): void;
}): Promise<void> {
  const { chosen, parts, worker, signal, shutdown } = context;
  const done = worker.done.finally(shutdown);
  const path = process.env["V3_WORKER_HEALTH_FILE"];
  const heartbeat = path ? startHeartbeat(path, `${chosen.name}-worker`) : Promise.resolve();
  const monitor = chosen.roles.some((entry) => entry.role === "resources")
    ? parts.resourceHealth.run(signal)
    : Promise.resolve();
  const recovery = chosen.roles.some((entry) => entry.role === "resources")
    ? runStopSweep(parts, signal)
    : Promise.resolve();
  const queues = chosen.roles.map((entry) => `${entry.role}:${entry.taskQueue}`);
  parts.log.info({ process: chosen.name, queues }, "worker process running");
  try {
    await Promise.all([done, monitor, heartbeat, recovery]);
  } finally {
    shutdown();
    await Promise.allSettled([done, monitor, recovery]);
    parts.log.info({ process: chosen.name }, "worker process stopping");
    await (await heartbeat)?.stop();
  }
}
