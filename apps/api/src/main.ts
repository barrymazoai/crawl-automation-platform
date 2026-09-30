import { createLogger, startHeartbeat } from "@crawl-automation/platform";
import { apiContext } from "./api-context.js";
import { loadApiConfig } from "./config.js";
import { buildContainer } from "./container.js";
import { createHttpApp, listen } from "./server.js";

/** Reports health when the deployment names a health file (`V3_WORKER_HEALTH_FILE`, set by launchd). */
async function heartbeat() {
  const path = process.env["V3_WORKER_HEALTH_FILE"];
  return path ? startHeartbeat(path, "api") : { stop: async () => undefined };
}

/** Starts the API, the delivery runner, the queue dispatcher, brand scans and the cleanup loop; stops them cleanly on SIGTERM or SIGINT. */
async function main(): Promise<void> {
  const config = await loadApiConfig();
  const container = await buildContainer(config);
  const { log, deliveryRunner, queueDispatcher, cleanup, database, temporal } = container.cradle;
  const { runner: brandScanRunner } = container.cradle.brandScanParts;
  const server = await listen(createHttpApp(apiContext(container.cradle)), config.api);
  const health = await heartbeat();
  log.info({ host: config.api.host, port: config.api.port }, "api listening");

  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  await Promise.all([
    deliveryRunner.run(stop.signal),
    queueDispatcher.run(stop.signal),
    brandScanRunner?.run(stop.signal),
    cleanup.run(stop.signal),
  ]);

  log.info("api stopping");
  await health.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  await temporal.close();
  container.cradle.storageReaders?.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    createLogger({ name: "api", destination: process.stderr }).fatal(
      { err: String(error) },
      "api failed",
    );
    process.exit(1);
  },
);
