import { createLogger } from "@crawl-automation/platform";
import { loadWorkerConfig } from "./load-config.js";
import { buildContainer } from "./container.js";
import { runProcess } from "./processes/run-process.js";
import { selectProcess } from "./processes/select-process.js";
import { withNamedEgoSpace } from "./browser/named-ego-space.js";

/**
 * Runs one of the machine's worker processes (`V3_WORKER_PROCESS`; the pipeline when unset): every role the config
 * groups into it, one Temporal worker per role, until SIGTERM or SIGINT.
 */
async function main(): Promise<void> {
  const loaded = await loadWorkerConfig();
  const chosen = selectProcess(loaded, process.env["V3_WORKER_PROCESS"]);
  const config = await withNamedEgoSpace(loaded, chosen);
  const container = await buildContainer(config);
  const { database, r2 } = container.cradle;
  try {
    await runProcess(chosen, container.cradle);
  } finally {
    await container.dispose();
    r2.close();
    await database.close();
  }
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
