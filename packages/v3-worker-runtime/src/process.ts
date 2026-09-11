import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Runtime } from "@temporalio/worker";
import { parseWorkerConfig } from "./config.js";
import { runRegisteredWorker } from "./lifecycle.js";
import { connectTemporal } from "./temporal.js";
import type { RoleRegistry } from "./registry.js";
import { WorkerHealthFile } from "./health.js";

// Hash the actual entry bundle and any Workflow bundles, not a caller-supplied version label.
export async function artifactBuildId(paths: readonly string[]): Promise<string> {
  if (!paths.length) throw new Error("No build artifacts");
  const hash = createHash("sha256");
  for (const path of paths) {
    const bytes = await readFile(path);
    hash.update(String(bytes.length)); hash.update(":"); hash.update(bytes);
  }
  return hash.digest("hex");
}
export async function workerProcess(registry: RoleRegistry): Promise<void> {
  if (process.argv.includes("--list")) { console.log(JSON.stringify(registry.list())); return; }
  if (process.env.V3_WORKER_ENABLED !== "true" || !process.env.V3_WORKER_CONFIG || !isAbsolute(process.env.V3_WORKER_CONFIG))
    throw new Error("Explicit V3_WORKER_ENABLED and absolute V3_WORKER_CONFIG required");
  const config = parseWorkerConfig(JSON.parse(await readFile(process.env.V3_WORKER_CONFIG, "utf8")));
  registry.select(config);
  const controller = new AbortController();
  const health = process.env.V3_WORKER_HEALTH_FILE ? new WorkerHealthFile(process.env.V3_WORKER_HEALTH_FILE) : undefined;
  await health?.flush();
  const healthTimer = health ? setInterval(()=>{void health.flush().catch(()=>stop());},5000) : undefined;
  let timeout: NodeJS.Timeout | undefined;
  let startup: NodeJS.Timeout | undefined;
  const fatal = () => {
    console.error(JSON.stringify({ event: "WORKER_PROCESS_TIMEOUT", outcome: "unknown_preserve_evidence" }));
    process.exit(1);
  };
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    timeout = setTimeout(fatal, config.shutdownForceMs + 1000);
  };
  // Windows parent supervisor uses IPC; SIGTERM is not graceful on Windows.
  const onMessage=(message:unknown)=>{if(message&&typeof message==="object"&&(message as {type?:string}).type==="v3-stop")stop();};
  if(process.send)process.on("message",onMessage);
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  Runtime.install({ shutdownSignals: [] });
  startup = setTimeout(fatal, config.startupTimeoutMs);
  try {
    await runRegisteredWorker(config, registry, {
      connect: connectTemporal,
      report: event => {
        if (event.event === "WORKER_RUNNING") clearTimeout(startup);
        console.log(JSON.stringify(event));
        void health?.report(event).catch(()=>stop());
      },
    }, controller.signal);
  } catch {
    await health?.report({event:"WORKER_FATAL"}).catch(()=>{});
    console.error(JSON.stringify({ event: "WORKER_FATAL", outcome: "unknown_preserve_evidence" }));
    // Includes unsafe SDK shutdown; never leave live Activity callbacks in a failed daemon.
    process.exit(1);
  } finally {
    clearInterval(healthTimer);
    await health?.flush().catch(()=>{});
    clearTimeout(startup); clearTimeout(timeout);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);process.off("message",onMessage);
  }
}
