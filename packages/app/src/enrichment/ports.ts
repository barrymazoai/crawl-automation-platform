import type { ObjectStore, RetainedPublication } from "@crawl-automation/platform";
import type { TextModel } from "@crawl-automation/processing";
import type { EnrichmentTitleReader } from "./title-reader.js";
import type {
  EnrichmentRequest,
  EnrichmentSubject,
  LabelCollectedProduct,
  ReviewRecord,
  SharedEnrichmentRecord,
  SharedEnrichmentOutcome,
} from "@crawl-automation/v3-contracts";

export interface EnrichmentSource {
  subject: EnrichmentSubject;
  collection: LabelCollectedProduct;
}

export interface EnrichmentRepository {
  source(request: EnrichmentRequest): Promise<EnrichmentSource>;
  /** Immutable insert, with one winner globally; unknown acknowledgement never permits execution. */
  claim(inputHash: string, subject: EnrichmentSubject): Promise<boolean>;
  read(inputHash: string): Promise<SharedEnrichmentRecord | null>;
  register(record: SharedEnrichmentRecord): Promise<void>;
  attach(subject: EnrichmentSubject, inputHash: string): Promise<void>;
  missing(limit: number): Promise<EnrichmentRequest[]>;
}

export interface EnrichmentDependencies {
  titles?: Pick<EnrichmentTitleReader, "read">;
  repository: EnrichmentRepository;
  publication: Pick<RetainedPublication, "publish">;
  remote: Pick<ObjectStore, "read">;
  reviews: {
    append(record: ReviewRecord): Promise<unknown>;
    read(reviewId: string): Promise<ReviewRecord | null>;
  };
  model: Pick<TextModel, "provider" | "interpret">;
}

export interface EnrichmentStarter {
  start(request: EnrichmentRequest): Promise<{ workflowId: string }>;
}
export type EnrichmentRun = (request: EnrichmentRequest) => Promise<SharedEnrichmentOutcome>;
