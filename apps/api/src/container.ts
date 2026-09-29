import { access } from "node:fs/promises";
import {
  FleetStatusFiles,
  PostgresBrandStore,
  PostgresDeliveryJournal,
  PostgresDeliveryScan,
  PostgresProductStore,
  PostgresQueueStore,
  PostgresResourceStore,
  PostgresReviewStore,
  PostgresRunStore,
  TemporalWorkflowStarter,
  TemporalWorkflowTree,
} from "@crawl-automation/adapters";
import {
  BrandService,
  DeliveryCoordinator,
  DeliveryRunner,
  FleetService,
  ProductService,
  QueueService,
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
  resources: ResourceService;
  fleet: FleetService;
  deliveryRunner: DeliveryRunner;
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
  const container = createContainer<ApiParts>({ injectionMode: InjectionMode.PROXY, strict: true });
  container.register({ config: asValue(config), log: asValue(log), temporal: asValue(temporal) });
  registerAdapters(container);
  registerServices(container);
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
    runs: asFunction(
      (parts: ApiParts) =>
        new RunService({
          runs: parts.runStore,
          tree: parts.workflowTree,
          permits: parts.resourceStore,
          log: parts.log,
        }),
    ).singleton(),
    queue: asFunction(
      (parts: ApiParts) =>
        new QueueService({ queue: new PostgresQueueStore(parts.database), log: parts.log }),
    ).singleton(),
    brands: asFunction(
      (parts: ApiParts) =>
        new BrandService({ brands: new PostgresBrandStore(parts.database), log: parts.log }),
    ).singleton(),
    reviews: asFunction(
      (parts: ApiParts) => new ReviewService({ reviews: new PostgresReviewStore(parts.database) }),
    ).singleton(),
    products: asFunction(
      (parts: ApiParts) =>
        new ProductService({ products: new PostgresProductStore(parts.database) }),
    ).singleton(),
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
    deliveryRunner: asFunction(deliveryRunner).singleton(),
  });
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
