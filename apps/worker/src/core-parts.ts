import type { PostgresFormulaIndex, PostgresReviewLedger } from "@crawl-automation/adapters";
import type {
  AmazonFormulaRequests,
  FormulaLookup,
  LabelHandoffs,
  PipelineCapture,
  ProductReviews,
  SiblingFormulaReuse,
} from "@crawl-automation/app";
import type {
  ChannelRegistry,
  ProductCapture,
  ProductFiles,
  ProductPlans,
} from "@crawl-automation/channels-core";
import type { Database, Logger } from "@crawl-automation/platform";
import type { FileTransport } from "@crawl-automation/channels-core";
import type { createR2Objects, FileCopies, RetainedPublication } from "@crawl-automation/platform";
import type { LocalObjectStore } from "@crawl-automation/platform";
import type { WorkerConfig } from "./config.js";

type R2 = ReturnType<typeof createR2Objects>;

/**
 * The worker's base services, registered in the container first. The label and browser parts are built from these
 * (see `container.ts`), so their builders depend on this interface and never on the container itself.
 */
export interface CoreParts {
  config: WorkerConfig;
  log: Logger;
  database: Database;
  r2: R2;
  local: LocalObjectStore;
  copies: FileCopies;
  publication: RetainedPublication;
  registry: ChannelRegistry;
  fileTransport: FileTransport;
  reviewLedger: PostgresReviewLedger;
  channelPlans: ProductPlans;
  productCapture: ProductCapture;
  pipelineCapture: PipelineCapture;
  productFiles: ProductFiles;
  formulaIndex: PostgresFormulaIndex;
  formulaLookup: FormulaLookup;
  siblingReuse: SiblingFormulaReuse;
  amazonFormulaRequests: AmazonFormulaRequests;
  labelHandoffs: LabelHandoffs;
  productReviews: ProductReviews;
}
