import type {
  PostgresResourceStore,
  PostgresRunStore,
  TemporalWorkflowTree,
} from "@crawl-automation/adapters";
import { ListRuns, RunService, type QueueService } from "@crawl-automation/app";
import type { Database, Logger, TemporalClient } from "@crawl-automation/platform";
import type { BrandScanParts } from "./brand-scan-parts.js";
import type { ApiConfig } from "./config.js";
import { channelRegistry, productRuns } from "./queue-parts.js";

/** What the run service is built from (named, so the container's cradle is never spread). */
export interface RunParts {
  config: Pick<ApiConfig, "pipeline">;
  database: Database;
  temporal: TemporalClient;
  runStore: PostgresRunStore;
  resourceStore: PostgresResourceStore;
  workflowTree: TemporalWorkflowTree;
  queue: QueueService;
  brandScanParts: BrandScanParts;
  log: Logger;
}

/**
 * Runs: product runs start their workflow at once, list runs queue their pages, and brand runs request their brand
 * scan before the delivery runner starts their CollectionWorkflow.
 */
export function runService(parts: RunParts): RunService {
  return new RunService({
    runs: parts.runStore,
    tree: parts.workflowTree,
    permits: parts.resourceStore,
    productRuns: productRuns(parts),
    listRuns: new ListRuns({ registry: channelRegistry(), queue: parts.queue }),
    brandScans: parts.brandScanParts.brandScans,
    log: parts.log,
  });
}
