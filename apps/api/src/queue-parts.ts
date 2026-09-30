import {
  PostgresChannelQueueStore,
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
  config: Pick<ApiConfig, "pipeline">;
}): ProductRuns {
  return new ProductRuns({
    store: new PostgresProductRunStore(parts.database),
    starter: new TemporalPipelineStarter(parts.temporal.client),
    registry: channelRegistry(),
    targets: parts.config.pipeline,
  });
}

/** Amazon's queue on its existing tables; every other channel's on the shared queue tables. */
export function queueService(database: Database, log: Logger): QueueService {
  return new QueueService({
    amazon: new PostgresQueueStore(database),
    channels: new PostgresChannelQueueStore(database),
    log,
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
