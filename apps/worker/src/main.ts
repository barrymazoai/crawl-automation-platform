import { startHeartbeat } from "@crawl-automation/platform";
import { runWorker } from "@crawl-automation/platform/temporal-worker";
import { pipelineActivities } from "./activities/pipeline-activities.js";
import { loadWorkerConfig } from "./config.js";
import { buildContainer } from "./container.js";

/** Reports health when the deployment names a health file (`V3_WORKER_HEALTH_FILE`, set by launchd). */
async function heartbeat() {
  const path = process.env["V3_WORKER_HEALTH_FILE"];
  return path ? startHeartbeat(path, "pipeline-worker") : { stop: async () => undefined };
}

/** Runs the product pipeline (workflow and activities) on one task queue until SIGTERM or SIGINT. */
async function main(): Promise<void> {
  const config = await loadWorkerConfig();
  const container = await buildContainer(config);
  const { log, database, r2 } = container.cradle;
  const worker = await runWorker(config.temporal, {
    taskQueue: config.taskQueue,
    workflowBundlePath: new URL("./workflows.cjs", import.meta.url).pathname,
    activities: pipelineActivities(container.cradle),
    maxConcurrentActivities: config.maxConcurrentActivities,
  });
  const health = await heartbeat();
  log.info({ taskQueue: config.taskQueue }, "pipeline worker running");
  process.once("SIGTERM", () => worker.shutdown());
  process.once("SIGINT", () => worker.shutdown());
  await worker.done;

  log.info("pipeline worker stopping");
  await health.stop();
  r2.close();
  await database.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ level: 60, msg: "pipeline worker failed", err: String(error) })}\n`,
    );
    process.exit(1);
  },
);
