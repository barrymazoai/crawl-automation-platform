import { NativeConnection, Worker, type WorkerOptions } from "@temporalio/worker";
import type { TemporalConfig } from "../config/schemas.js";
import type { Logger } from "../logger/create-logger.js";
import { temporalConnectionOptions } from "../temporal/connect-temporal.js";
import { installTemporalLogger } from "./temporal-logger.js";

export interface WorkerSpec {
  taskQueue: string;
  /** The prebuilt workflow bundle (`bundleWorkflowCode` at build time), or none for an activity-only worker. */
  workflowBundlePath?: string;
  activities: NonNullable<WorkerOptions["activities"]>;
  maxConcurrentActivities: number;
  /** How many workflow tasks run at once; the SDK default when unset. */
  maxConcurrentWorkflowTasks?: number;
  /** The process logger; the Temporal SDK's own lines then go through it too. */
  log?: Logger;
}

export interface RunningWorker {
  /** Resolves when every worker has stopped (after `shutdown` or a fatal error of any of them). */
  done: Promise<void>;
  shutdown(): void;
}

/** The one place that runs a Temporal worker: connects, polls one task queue, and stops on request. */
export function runWorker(config: TemporalConfig, spec: WorkerSpec): Promise<RunningWorker> {
  return runWorkers(config, [spec]);
}

/**
 * Runs several workers in one process over one connection: one worker per task queue, as the process's roles need.
 * If one worker stops with an error, all are shut down, so the process never keeps running half its roles.
 */
export async function runWorkers(
  config: TemporalConfig,
  specs: readonly WorkerSpec[],
): Promise<RunningWorker> {
  const log = specs.find((spec) => spec.log)?.log;
  if (log) {
    installTemporalLogger(log);
  }
  const { tls } = await temporalConnectionOptions(config);
  const connection = await NativeConnection.connect({
    address: config.address,
    ...(tls ? { tls } : {}),
  });
  const workers = await Promise.all(
    specs.map((spec) => Worker.create(workerOptions(connection, config.namespace, spec))),
  );
  const shutdown = () => workers.forEach((worker) => stopOnce(worker));
  const runs = workers.map((worker) =>
    worker.run().catch((error: unknown) => {
      shutdown();
      throw error;
    }),
  );
  const done = Promise.all(runs)
    .then(() => undefined)
    .finally(() => connection.close());
  return { done, shutdown };
}

function workerOptions(connection: NativeConnection, namespace: string, spec: WorkerSpec) {
  return {
    connection,
    namespace,
    taskQueue: spec.taskQueue,
    activities: spec.activities,
    maxConcurrentActivityTaskExecutions: spec.maxConcurrentActivities,
    ...(spec.maxConcurrentWorkflowTasks
      ? { maxConcurrentWorkflowTaskExecutions: spec.maxConcurrentWorkflowTasks }
      : {}),
    ...(spec.workflowBundlePath ? { workflowBundle: { codePath: spec.workflowBundlePath } } : {}),
  } satisfies WorkerOptions;
}

/** A worker that has already begun stopping ignores a second request. */
function stopOnce(worker: Worker): void {
  if (worker.getState() === "RUNNING") {
    worker.shutdown();
  }
}
