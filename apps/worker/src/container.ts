import {
  PostgresExecutionRegistry,
  PostgresFormulaIndex,
  PostgresFormulaLinks,
  PostgresListingStates,
  PostgresReviewLedger,
} from "@crawl-automation/adapters";
import {
  FormulaLookup,
  LabelHandoffs,
  PipelineCapture,
  ProductReviews,
  SiblingFormulaReuse,
  recordSighting,
} from "@crawl-automation/app";
import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { gncAdapter } from "@crawl-automation/channels-gnc";
import {
  ChannelRegistry,
  HttpCapture,
  ProductCapture,
  ProductFiles,
  ProductSourcePlans,
  ScraperApiPages,
} from "@crawl-automation/channels-core";
import {
  createDatabase,
  createLogger,
  ScraperApiClient,
  type Database,
  type Logger,
} from "@crawl-automation/platform";
import {
  DirectHttpsTransport,
  FileEvidence,
  SystemHttpsTransport,
  type FileTransport,
} from "@crawl-automation/v3-acquisition";
import {
  ArtifactResolver,
  createR2Objects,
  FileCopies,
  RetainedPublication,
} from "@crawl-automation/v3-artifacts";
import { ChannelProductPlans } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from "awilix";
import type { WorkerConfig } from "./config.js";

type R2 = ReturnType<typeof createR2Objects>;

/** Everything the pipeline worker is built from. */
export interface WorkerParts {
  config: WorkerConfig;
  log: Logger;
  database: Database;
  r2: R2;
  local: TextLocalStore;
  copies: FileCopies;
  publication: RetainedPublication;
  registry: ChannelRegistry;
  fileTransport: FileTransport;
  reviewLedger: PostgresReviewLedger;
  channelPlans: ChannelProductPlans;
  productCapture: ProductCapture;
  pipelineCapture: PipelineCapture;
  productFiles: ProductFiles;
  formulaIndex: PostgresFormulaIndex;
  formulaLookup: FormulaLookup;
  siblingReuse: SiblingFormulaReuse;
  labelHandoffs: LabelHandoffs;
  productReviews: ProductReviews;
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
    local: asValue(await TextLocalStore.open(storage.journalRoot)),
    copies: asValue(await FileCopies.open(storage.cacheRoot)),
    // Channels this worker can collect. A new channel is one adapter added here.
    registry: asValue(new ChannelRegistry([swansonAdapter, gncAdapter])),
    fileTransport: asValue(
      config.files.resolve === "system" ? new SystemHttpsTransport() : new DirectHttpsTransport(),
    ),
  });
  registerStores(container);
  registerServices(container);
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
    channelPlans: asFunction(
      ({ publication, copies, r2, reviewLedger }: WorkerParts) =>
        new ChannelProductPlans(publication, new ArtifactResolver(copies, r2.store), reviewLedger),
    ).singleton(),
  });
}

function registerServices(container: Parts): void {
  container.register({
    productCapture: asFunction(captureService).singleton(),
    // A revisit that finds the listing unlisted records that sighting (with its reason) instead of a Review.
    pipelineCapture: asFunction(({ productCapture, database }: WorkerParts) => {
      const listingStates = new PostgresListingStates(database);
      const listings = { record: (raw: unknown) => recordSighting(listingStates, raw) };
      return new PipelineCapture({ capture: productCapture, listings });
    }).singleton(),
    productFiles: asFunction(filesService).singleton(),
    // Formula once across the channel's formula family, then a size or pack sibling's formula after a label check.
    formulaLookup: asFunction(
      ({ formulaIndex }: WorkerParts) => new FormulaLookup(formulaIndex),
    ).singleton(),
    siblingReuse: asFunction(
      ({ formulaIndex, database }: WorkerParts) =>
        new SiblingFormulaReuse({ index: formulaIndex, links: new PostgresFormulaLinks(database) }),
    ).singleton(),
    labelHandoffs: asFunction(
      ({ registry, channelPlans, publication, database, config }: WorkerParts) =>
        new LabelHandoffs({
          registry,
          plans: channelPlans,
          evidence: publication,
          executions: new PostgresExecutionRegistry(database),
          settings: config.label,
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
  const { route, scraperApi, channels } = config.capture;
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
  const settings = { ...config.plan, egressId: fileTransport.egressId };
  return new ProductCapture({
    registry,
    http: new HttpCapture(pages),
    publication,
    sourcePlans: new ProductSourcePlans(publication, settings),
  });
}

function filesService(parts: WorkerParts): ProductFiles {
  const { registry, channelPlans, local, r2, copies, reviewLedger, fileTransport } = parts;
  const files = new FileEvidence({ local, remote: r2.store, copies, reviews: reviewLedger });
  return new ProductFiles({ registry, plans: channelPlans, files, transport: fileTransport });
}
