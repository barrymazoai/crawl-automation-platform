import { access } from "node:fs/promises";
import {
  FleetStatusFiles,
  PostgresBrandStore,
  PostgresDeliveryJournal,
  PostgresDeliveryScan,
  PostgresResourceStore,
  PostgresReviewStore,
  PostgresRunStore,
  TemporalWorkflowStarter,
  TemporalWorkflowTree,
} from "@crawl-automation/adapters";
import {
  BrandService,
  CleanupService,
  DeliveryCoordinator,
  DeliveryRunner,
  FleetService,
  type HistoryService,
  type ProductService,
  QueueService,
  type ListingStateService,
  type QueueDispatcher,
  ResourceService,
  ReviewService,
  RunService,
} from "@crawl-automation/app";
import {
  connectTemporal,
  createDatabase,
  createLogger,
  type Database,
  type Logger,
  type TemporalClient,
} from "@crawl-automation/platform";
import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from "awilix";
import type { ApiConfig } from "./config.js";
import { evidenceReaders } from "./evidence-readers.js";
import { brandScanParts, type BrandScanParts } from "./brand-scan-parts.js";
import { runService } from "./run-parts.js";
import { listingStateService, productRuns, queueDispatcher, queueService } from "./queue-parts.js";
import { historyService, productService } from "./results-parts.js";

/** Everything the API is built from. Adapters are created once and shared. */
export interface ApiParts {
  config: ApiConfig;
  log: Logger;
  temporal: TemporalClient;
  database: Database;
  runStore: PostgresRunStore;
  resourceStore: PostgresResourceStore;
  workflowTree: TemporalWorkflowTree;
  deliveryCoordinator: DeliveryCoordinator;
  runs: RunService;
  queue: QueueService;
  brands: BrandService;
  reviews: ReviewService;
  products: ProductService;
  history: HistoryService;
  resources: ResourceService;
  fleet: FleetService;
  listingStates: ListingStateService;
  brandScanParts: BrandScanParts;
  deliveryRunner: DeliveryRunner;
  queueDispatcher: QueueDispatcher;
  cleanup: CleanupService;
}

type Parts = AwilixContainer<ApiParts>;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The composition root: the one place that knows which database, Temporal and files are used. */
export async function buildContainer(config: ApiConfig): Promise<Parts> {
  const log = createLogger({ name: "api", level: config.log.level });
  const temporal = await connectTemporal(config.temporal);
  return assembleContainer({ config, log, temporal });
}

/** Every part of the API, registered around its already-open connections (tests pass stand-ins). */
export function assembleContainer(base: Pick<ApiParts, "config" | "log" | "temporal">): Parts {
  const container = createContainer<ApiParts>({ injectionMode: InjectionMode.PROXY, strict: true });
  container.register({
    config: asValue(base.config),
    log: asValue(base.log),
    temporal: asValue(base.temporal),
  });
  registerAdapters(container);
  registerServices(container);
  registerLoops(container);
  return container;
}

function registerAdapters(container: Parts): void {
  container.register({
    database: asFunction((parts: ApiParts) =>
      createDatabase(parts.config.database, parts.log),
    ).singleton(),
    runStore: asFunction((parts: ApiParts) => new PostgresRunStore(parts.database)).singleton(),
    resourceStore: asFunction(
      (parts: ApiParts) => new PostgresResourceStore(parts.database),
    ).singleton(),
    workflowTree: asFunction(
      (parts: ApiParts) => new TemporalWorkflowTree(parts.temporal.client),
    ).singleton(),
    deliveryCoordinator: asFunction(deliveryCoordinator).singleton(),
  });
}

function registerServices(container: Parts): void {
  container.register({
    runs: asFunction(runService).singleton(),
    queue: asFunction((parts: ApiParts) => queueService(parts.database, parts.log)).singleton(),
    brands: asFunction(
      (parts: ApiParts) =>
        new BrandService({ brands: new PostgresBrandStore(parts.database), log: parts.log }),
    ).singleton(),
    reviews: asFunction(reviewService).singleton(),
    products: asFunction(productService).singleton(),
    history: asFunction(historyService).singleton(),
    resources: asFunction(
      (parts: ApiParts) =>
        new ResourceService({
          resources: parts.resourceStore,
          workflows: parts.workflowTree,
          log: parts.log,
        }),
    ).singleton(),
    fleet: asFunction(
      (parts: ApiParts) => new FleetService({ source: new FleetStatusFiles(parts.config.fleet) }),
    ).singleton(),
    listingStates: asFunction((parts: ApiParts) =>
      listingStateService(parts.database, parts.queue),
    ).singleton(),
  });
}

/** The background loops the API process runs: delivery of accepted runs, the product queue, brand scans, cleanup. */
function registerLoops(container: Parts): void {
  container.register({
    deliveryRunner: asFunction(deliveryRunner).singleton(),
    // Brand scans: their services, and their runner when this process has scan settings.
    // Named fields only: spreading the cradle would resolve every registration, this one included (a cycle).
    brandScanParts: asFunction((parts: ApiParts) =>
      brandScanParts({
        database: parts.database,
        queue: parts.queue,
        listingStates: parts.listingStates,
        settings: parts.config.brandScans,
        temporal: parts.temporal,
        log: parts.log,
      }),
    ).singleton(),

    queueDispatcher: asFunction((parts: ApiParts) =>
      queueDispatcher(
        {
          database: parts.database,
          temporal: parts.temporal,
          runs: parts.runs,
          log: parts.log,
          productRuns: productRuns(parts),
          isPaused: () => exists(parts.config.delivery.pauseFile),
        },
        parts.config.queue.dispatcher,
      ),
    ).singleton(),
    cleanup: asFunction(
      (parts: ApiParts) =>
        new CleanupService({
          resources: parts.resources,
          runs: parts.runs,
          log: parts.log,
          intervalMs: parts.config.cleanup.intervalMs,
        }),
    ).singleton(),
  });
}

/** Reviews from the ledger; their evidence from R2 when the API has storage settings. */
function reviewService(parts: ApiParts): ReviewService {
  const reviews = new PostgresReviewStore(parts.database);
  const storage = parts.config.storage;
  return new ReviewService(
    storage ? { reviews, evidence: evidenceReaders(storage).readers } : { reviews },
  );
}

function deliveryCoordinator(parts: ApiParts): DeliveryCoordinator {
  const { clusterId, channels } = parts.config.delivery;
  return new DeliveryCoordinator({
    submissions: parts.runStore,
    journal: new PostgresDeliveryJournal(parts.database),
    starter: new TemporalWorkflowStarter(parts.temporal.client),
    routes: { clusterId, namespace: parts.config.temporal.namespace, channels },
  });
}

function deliveryRunner(parts: ApiParts): DeliveryRunner {
  const scan = new PostgresDeliveryScan(parts.database);
  const isPaused = () => exists(parts.config.delivery.pauseFile);
  return new DeliveryRunner(
    { scan, coordinator: parts.deliveryCoordinator, isPaused, log: parts.log },
    parts.config.delivery.runner,
  );
}
