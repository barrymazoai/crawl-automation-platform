import { loadApiConfig } from "./config.js";
import { buildContainer } from "./container.js";
import { createHttpApp, listen } from "./server.js";

/** Starts the API and the delivery runner; stops both cleanly on SIGTERM or SIGINT. */
async function main(): Promise<void> {
  const config = await loadApiConfig();
  const container = await buildContainer(config);
  const { log, deliveryRunner, database, temporal } = container.cradle;
  const { runs, queue, brands, reviews, products, resources, fleet } = container.cradle;
  const context = { runs, queue, brands, reviews, products, resources, fleet };
  const server = await listen(createHttpApp(context), config.api);
  log.info({ host: config.api.host, port: config.api.port }, "api listening");

  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  await deliveryRunner.run(stop.signal);

  log.info("api stopping");
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
