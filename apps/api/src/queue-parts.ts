import { configuredDtcSites } from "@crawl-automation/channel-dtc";
import {
  PostgresChannelQueueStore,
  PostgresBrandScans,
  PostgresListingStates,
  PostgresProductRunStore,
  PostgresQueueDispatch,
  PostgresQueueStore,
  TemporalPipelineStarter,
  TemporalRunExecutions,
} from "@crawl-automation/adapters";
import {
  ListingStateService,
  ProductRuns,
  QueueDispatcher,
  QueueService,
  type RunService,
} from "@crawl-automation/app";
import type { Database, Logger, TemporalClient } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";
import { channelRegistry } from "./resources/channel-registry.js";

export { channelRegistry } from "./resources/channel-registry.js";

/** Product runs: started straight away on the shared pipeline. A channel is enabled by its adapter and config. */
export function productRuns(parts: {
  database: Database;
  temporal: TemporalClient;
  config: Pick<ApiConfig, "pipeline" | "browser">;
}): ProductRuns {
  return new ProductRuns({
    store: new PostgresProductRunStore(parts.database),
    sources: new PostgresBrandScans(parts.database),
    starter: new TemporalPipelineStarter(parts.temporal.client),
    registry: channelRegistry(configuredDtcSites(parts.config.browser?.dtc)),
    targets: parts.config.pipeline,
  });
}

/** Every channel uses the shared queue; Amazon's legacy store only supplies a migration preview. */
export function queueService({
  database,
  log,
  config,
}: {
  database: Database;
  log: Logger;
  config: Pick<ApiConfig, "queue">;
}): QueueService {
  return new QueueService({
    amazonHistory: new PostgresQueueStore(database),
    channels: new PostgresChannelQueueStore(database),
    log,
    scanAdmission: { recentScanSkipHours: config.queue.recentScanSkipHours },
  });
}

/** Listing states; revisits a full brand scan asks for go through the shared queue. */
export function listingStateService(database: Database, queue: QueueService): ListingStateService {
  return new ListingStateService({ store: new PostgresListingStates(database), queue });
}

export interface DispatcherParts {
  database: Database;
  temporal: TemporalClient;
  runs: RunService;
  productRuns: ProductRuns;
  isPaused: () => Promise<boolean>;
  log: Logger;
}

/** Starts queued products through the same product-run service as `runs.submit`; the pause file stops starts. */
export function queueDispatcher(
  parts: DispatcherParts,
  settings: ApiConfig["queue"]["dispatcher"],
): QueueDispatcher {
  return new QueueDispatcher(
    {
      store: new PostgresQueueDispatch(parts.database),
      executions: new TemporalRunExecutions(parts.temporal.client),
      starter: parts.productRuns,
      canceller: parts.runs,
      isPaused: parts.isPaused,
      log: parts.log,
    },
    settings,
  );
}
