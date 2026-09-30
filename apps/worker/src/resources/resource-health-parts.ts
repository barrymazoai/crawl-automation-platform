import { randomUUID } from "node:crypto";
import { DiskSpace, FleetOcrHealth, PostgresResourceHealth } from "@crawl-automation/adapters";
import { TemporalTaskQueues } from "@crawl-automation/adapters";
import { ResourceHealthMonitor } from "@crawl-automation/app";
import { connectTemporal } from "@crawl-automation/platform";
import type { CoreParts } from "../core-parts.js";

export interface ResourceHealthRunner {
  run(signal: AbortSignal): Promise<void>;
}

/** Lazy composition: other roles never connect a monitoring client or write health. */
export function buildResourceHealth(parts: CoreParts): ResourceHealthRunner {
  return { run: (signal) => runResourceHealth(parts, signal) };
}

async function runResourceHealth(parts: CoreParts, signal: AbortSignal): Promise<void> {
  const settings = parts.config.resourceHealth;
  const log = parts.log.child({ runId: randomUUID(), service: "resource-health" });
  if (!settings) {
    log.info("resource health is not configured");
    return;
  }
  const temporal = await connectTemporal(parts.config.temporal);
  try {
    const monitor = new ResourceHealthMonitor(
      {
        repository: new PostgresResourceHealth(parts.database),
        taskQueues: new TemporalTaskQueues(temporal.client),
        ocr: new FleetOcrHealth(settings.ocrApi),
        disk: new DiskSpace(),
        log,
      },
      settings,
    );
    await monitor.run(signal);
  } finally {
    await temporal.close();
  }
}
