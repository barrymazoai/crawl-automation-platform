import { siblingReuseService } from "./sibling-reuse-parts.js";
import { filesService } from "./product-files-parts.js";
import { registerActivityPolicies } from "./activities/activity-policies.js";
import { persistedWorkerRegistry } from "./channel-registry.js";
import { activityContextParts } from "./activities/activity-context-parts.js";
import { PostgresPermitExecutions } from "@crawl-automation/adapters";
import { configurePermitActivityLedger } from "@crawl-automation/app";
import {
  type PostgresResourceAdmission,
  PostgresChannelQueueStore,
  PostgresExecutionRegistry,
  PostgresFormulaIndex,
  PostgresReviewLedger,
} from "@crawl-automation/adapters";
import {
  AmazonFormulaRequests,
  formulaFamilies,
  FormulaLookup,
  LabelHandoffs,
  type LabelReviews,
  type LabelTasks,
  ProductReviews,
} from "@crawl-automation/app";
import { amazonFormulaProduct } from "./amazon-formula-product.js";
import {
  ProductCapture,
  ProductPlans,
  ProductSourcePlans,
  ScraperApiPages,
  DirectHttpsTransport,
  SystemHttpsTransport,
} from "@crawl-automation/channels-core";
import { createDatabase, createLogger, ScraperApiClient } from "@crawl-automation/platform";
import {
  ArtifactResolver,
  createR2Objects,
  FileCopies,
  RetainedPublication,
  verifyBytes,
} from "@crawl-automation/platform";
import { LocalObjectStore } from "@crawl-automation/platform";
import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from "awilix";
import { buildBrowserParts, type BrowserParts } from "./browser/browser-parts.js";
import { recordedPipelineCapture, recordedHttpCapture } from "./capture-records.js";
import type { WorkerConfig } from "./config.js";
import type { CoreParts } from "./core-parts.js";
import { requireRoleSection } from "./processes/role-settings.js";
import {
  buildResourceHealth,
  type ResourceHealthRunner,
} from "./resources/resource-health-parts.js";
import {
  buildAdmission,
  buildLabelParts,
  buildLabelReviews,
  buildLabelTasks,
  type LabelParts,
} from "./label/label-parts.js";

/** Everything the pipeline worker is built from: the base services, then the parts built from them. */
export interface WorkerParts extends CoreParts {
  resourceHealth: ResourceHealthRunner;
  /** The label steps (only built when a label role first uses them). */
  label: LabelParts;
  labelTasks: LabelTasks;
  labelReviews: LabelReviews;
  admission: PostgresResourceAdmission;
  /** Browser product capture and brand scans on the Ego machine. */
  browser: BrowserParts;
}

export type Parts = AwilixContainer<WorkerParts>;

/** The composition root: the one place that knows which database, storage, provider and channels are used. */
export async function buildContainer(config: WorkerConfig): Promise<Parts> {
  const log = createLogger({ name: "worker", level: config.log.level });
  const { storage } = config;
  const container = createContainer<WorkerParts>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });
  container.register({
    config: asValue(config),
    log: asValue(log),
    database: asValue(createDatabase(config.database, log)),
    r2: asValue(createR2Objects(storage.r2, storage.r2Credentials)),
    local: asValue(await LocalObjectStore.open(storage.journalRoot)),
    copies: asValue(await FileCopies.open(storage.cacheRoot)),
    // Channels this worker can collect. A new channel is one adapter added here.
    registry: asFunction(({ database }: WorkerParts) =>
      persistedWorkerRegistry(config, database),
    ).singleton(),
    fileTransport: asValue(
      config.files.resolve === "system" ? new SystemHttpsTransport() : new DirectHttpsTransport(),
    ),
  });
  registerActivityPolicies(log, () => container.cradle.registry.refresh());
  activityContextParts(log, container.cradle.database);
  registerStores(container);
  configurePermitActivityLedger(new PostgresPermitExecutions(container.cradle.database));
  registerServices(container);
  container.register({
    label: asFunction(buildLabelParts).singleton(),
    labelTasks: asFunction(buildLabelTasks).singleton(),
    labelReviews: asFunction(buildLabelReviews).singleton(),
    admission: asFunction(buildAdmission).singleton(),
    browser: asFunction(buildBrowserParts).singleton(),
    resourceHealth: asFunction(buildResourceHealth).singleton(),
  });
  return container;
}

function registerStores(container: Parts): void {
  container.register({
    publication: asFunction(
      ({ local, r2 }: WorkerParts) => new RetainedPublication(local, r2.store),
    ).singleton(),
    reviewLedger: asFunction(
      ({ database }: WorkerParts) => new PostgresReviewLedger(database),
    ).singleton(),
    formulaIndex: asFunction(
      ({ database }: WorkerParts) => new PostgresFormulaIndex(database),
    ).singleton(),
    // One formula planner for every channel; each adapter's planning hook reads its own projection.
    channelPlans: asFunction(
      ({ registry, publication, copies, r2, reviewLedger }: WorkerParts) =>
        new ProductPlans({
          registry,
          publication,
          resolver: new ArtifactResolver(copies, r2.store),
          reviews: reviewLedger,
          integrity: { verifyBytes },
        }),
    ).singleton(),
  });
}

function registerServices(container: Parts): void {
  container.register({
    productCapture: asFunction(captureService).singleton(),
    // A revisit that finds the listing unlisted records that sighting (with its reason) instead of a Review.
    // Every captured page also adds one metrics-history point.
    pipelineCapture: asFunction(recordedPipelineCapture).singleton(),
    productFiles: asFunction(filesService).singleton(),
    // Formula once across the channel's formula family, then a size or pack sibling's formula after a label check.
    formulaLookup: asFunction(
      ({ formulaIndex, registry }: WorkerParts) =>
        new FormulaLookup(formulaIndex, formulaFamilies(registry)),
    ).singleton(),
    siblingReuse: asFunction(siblingReuseService).singleton(),
    // A Whole Foods ASIN with no Amazon formula is held once in Amazon's queue for its formula.
    amazonFormulaRequests: asFunction(
      ({ database }: WorkerParts) =>
        new AmazonFormulaRequests({
          queue: new PostgresChannelQueueStore(database),
          amazonProduct: amazonFormulaProduct,
        }),
    ).singleton(),
    labelHandoffs: asFunction(
      ({ registry, channelPlans, publication, database, config }: WorkerParts) =>
        new LabelHandoffs({
          registry,
          plans: channelPlans,
          evidence: publication,
          executions: new PostgresExecutionRegistry(database),
          settings: requireRoleSection(config, "label", "pipeline"),
        }),
    ).singleton(),
    productReviews: asFunction(
      ({ registry, publication, reviewLedger }: WorkerParts) =>
        new ProductReviews({ registry, evidence: publication, reviews: reviewLedger }),
    ).singleton(),
  });
}

function captureService(parts: WorkerParts): ProductCapture {
  const { config, registry, publication, fileTransport } = parts;
  const { route, scraperApi, channels, htmlReuseHours } = requireRoleSection(
    config,
    "capture",
    "pipeline",
  );
  const pages = new ScraperApiPages(new ScraperApiClient(scraperApi), {
    routeId: route.routeId,
    egressId: route.egressId,
    defaults: {
      countryCode: route.countryCode,
      sessionNumber: route.sessionNumber,
      render: route.responseMode === "rendered-html",
      premium: false,
    },
    channels,
  });
  // Planned image downloads are bound to the file transport's egress.
  const plan = requireRoleSection(config, "plan", "pipeline");
  const settings = { ...plan, egressId: fileTransport.egressId };
  return new ProductCapture({
    registry,
    http: recordedHttpCapture(pages, parts.database, htmlReuseHours),
    publication,
    sourcePlans: new ProductSourcePlans(publication, settings),
  });
}
