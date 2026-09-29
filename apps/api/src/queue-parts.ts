import {
  PostgresChannelQueueStore,
  PostgresListingStates,
  PostgresQueueDispatch,
  PostgresQueueStore,
  TemporalRunExecutions,
} from "@crawl-automation/adapters";
import {
  ListingStateService,
  QueueDispatcher,
  QueueService,
  type ProductRuns,
  type RunService,
} from "@crawl-automation/app";
import type { Database, Logger, TemporalClient } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";

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
