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
  /** The process logger; the Temporal SDK's own lines then go through it too. */
  log?: Logger;
}

export interface RunningWorker {
  /** Resolves when the worker has stopped (after `shutdown` or a fatal error). */
  done: Promise<void>;
  shutdown(): void;
}

/** The one place that runs a Temporal worker: connects, polls one task queue, and stops on request. */
export async function runWorker(config: TemporalConfig, spec: WorkerSpec): Promise<RunningWorker> {
  if (spec.log) {
    installTemporalLogger(spec.log);
  }
  const { tls } = await temporalConnectionOptions(config);
  const connection = await NativeConnection.connect({
    address: config.address,
    ...(tls ? { tls } : {}),
  });
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: spec.taskQueue,
    activities: spec.activities,
    maxConcurrentActivityTaskExecutions: spec.maxConcurrentActivities,
    ...(spec.workflowBundlePath ? { workflowBundle: { codePath: spec.workflowBundlePath } } : {}),
  });
  const done = worker.run().finally(() => connection.close());
  return { done, shutdown: () => worker.shutdown() };
}
