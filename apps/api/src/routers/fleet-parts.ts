import { Pm2FleetJobs, TemporalTaskQueues } from "@crawl-automation/adapters";
import { FleetService } from "@crawl-automation/app";
import type { TemporalClient } from "@crawl-automation/platform";
import type { ApiConfig } from "../config.js";
import { FleetOcrHealth } from "./fleet-ocr.js";

/** Fleet adapters are lazy: assembling the API neither attaches to PM2 nor probes services. */
export function fleetService(parts: { config: ApiConfig; temporal: TemporalClient }): FleetService {
  return new FleetService({
    jobs: new Pm2FleetJobs(),
    taskQueues: new TemporalTaskQueues(parts.temporal.client),
    queueNames: fleetQueueNames(parts.config),
    ocr: new FleetOcrHealth(parts.config.fleet.ocrApi),
  });
}

export function fleetQueueNames(config: ApiConfig): string[] {
  const channels = Object.values(config.pipeline.channels);
  const names = [
    ...config.fleet.taskQueues,
    ...Object.values(config.pipeline.queues),
    ...Object.values(config.delivery.channels).map((target) => target.taskQueue),
    ...channels.map((channel) => channel.resources.queue),
    config.brandScans?.browserQueue,
  ];
  return [...new Set(names.filter((name): name is string => Boolean(name) && name !== "none"))];
}
