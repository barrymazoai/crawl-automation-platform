import { workerProcess } from "@crawl-automation/v3-worker-runtime";
import { businessRegistry } from "./registry.js";

workerProcess(businessRegistry).catch(() => {
  console.error(JSON.stringify({ event: "WORKER_STARTUP_REJECTED", message: "Check implemented role, explicit configuration and build manifest" }));
  process.exitCode = 1;
});
