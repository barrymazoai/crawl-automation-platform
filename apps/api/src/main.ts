import { startHeartbeat } from "@crawl-automation/platform";
import { loadApiConfig } from "./config.js";
import { buildContainer } from "./container.js";
import { createHttpApp, listen } from "./server.js";

/** Reports health when the deployment names a health file (`V3_WORKER_HEALTH_FILE`, set by launchd). */
async function heartbeat() {
  const path = process.env["V3_WORKER_HEALTH_FILE"];
  return path ? startHeartbeat(path, "api") : { stop: async () => undefined };
}

/** Starts the API and the delivery runner; stops both cleanly on SIGTERM or SIGINT. */
async function main(): Promise<void> {
  const config = await loadApiConfig();
  const container = await buildContainer(config);
  const { log, deliveryRunner, database, temporal } = container.cradle;
  const { runs, queue, brands, reviews, products, resources, fleet } = container.cradle;
  const context = { runs, queue, brands, reviews, products, resources, fleet };
  const server = await listen(createHttpApp(context), config.api);
  const health = await heartbeat();
  log.info({ host: config.api.host, port: config.api.port }, "api listening");

  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  await deliveryRunner.run(stop.signal);

  log.info("api stopping");
  await health.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  await temporal.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ level: 60, msg: "api failed", err: String(error) })}\n`,
    );
    process.exit(1);
  },
);
