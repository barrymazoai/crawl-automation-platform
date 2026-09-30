import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { loadConfig, taskQueue } from "../bootstrap/config.js";
import { createWorkerContainer } from "../bootstrap/container.js";
import { createActivities } from "./activities.js";

async function main() {
  const config = loadConfig(process.env);
  Runtime.install({ shutdownSignals: [] });
  const container = createWorkerContainer(config.evidenceRoot);
  const connection = await NativeConnection.connect({
    address: config.address,
  });
  try {
    const activities = createActivities(container);
    const selected = {
      workflow: {},
      ocr: { ocrFile: activities.ocrFile },
      handoff: {
        verifyOcr: activities.verifyOcr,
        recordReview: activities.recordReview,
      },
      consume: { consumeOcr: activities.consumeOcr },
    }[config.role];
    const workflowOptions =
      config.role !== "workflow"
        ? {}
        : import.meta.url.endsWith(".ts")
          ? {
              workflowsPath: fileURLToPath(
                new URL("../workflows/index.ts", import.meta.url),
              ),
            }
          : {
              workflowBundle: {
                codePath: fileURLToPath(
                  new URL("./workflow-bundle.cjs", import.meta.url),
                ),
              },
            };
    const worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: taskQueue(config),
      identity: `${config.hostId}/${config.role}/${randomUUID()}/p0-1`,
      ...workflowOptions,
      activities: selected,
      maxConcurrentActivityTaskExecutions: config.concurrency,
      maxConcurrentActivityTaskPolls: config.concurrency,
      shutdownGraceTime: "10 seconds",
      shutdownForceTime: "15 seconds",
    });
    let stopping = false;
    const stop = () => {
      if (!stopping) {
        stopping = true;
        worker.shutdown();
      }
    };
    const running = worker.run();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(
      JSON.stringify({
        event: "worker.started",
        role: config.role,
        taskQueue: taskQueue(config),
        mode: "mock-local-only",
      }),
    );
    try {
      await running;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    await container.dispose();
    await connection.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Worker failed");
  process.exitCode = 1;
});
