import type { ChannelRegistry } from "@crawl-automation/channels-core";
import { sha256 } from "@crawl-automation/platform";
import {
  ReviewCodeSchema,
  ReviewRecordSchema,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import type { ErrorCategory } from "@crawl-automation/platform";
import type { ProductPipelineInput } from "@crawl-automation/workflows";
import type { EvidencePublisher, ReviewLedger } from "./ports.js";

export interface ReviewRequest {
  pipeline: ProductPipelineInput;
  /** The pipeline's own code for where it stopped. */
  code: string;
  /** The error code that caused it, when the failure carried one. */
  causeCode: string | null;
  executionFact?: ReviewRecord["failure"]["executionFact"] | undefined;
}

export interface ProductReview {
  status: "review";
  operationId: string;
  reviewId: string;
  code: string;
  evidenceKey: string;
  automaticRetry: false;
}

/** Which kind of problem a cause code names, by its area. */
const CATEGORY_BY_AREA: Record<string, ErrorCategory> = {
  SCRAPERAPI: "SOURCE",
  NETWORK: "SOURCE",
  CAPTURE: "SOURCE",
  SOURCE: "SOURCE",
  ARTIFACT: "ARTIFACT",
  RESOURCE: "SCHEDULER",
};

/**
 * One Review per product of a run when the pipeline cannot finish it. The Review records the real cause
 * (the error code the failure carried) and is never retried automatically.
 */
export class ProductReviews {
  constructor(
    private readonly deps: {
      registry: ChannelRegistry;
      evidence: EvidencePublisher;
      reviews: ReviewLedger;
    },
  ) {}

  async review(request: ReviewRequest, signal: AbortSignal): Promise<ProductReview> {
    const { pipeline } = request;
    const reviewId = `pipeline-review-${sha256(Buffer.from(pipeline.operationId))}`;
    const evidenceKey = `v3/pipeline-reviews/${reviewId}.json`;
    let record = await this.deps.reviews.read(reviewId);
    if (!record) {
      record = this.record({ request, reviewId, evidenceKey });
      const bytes = Buffer.from(JSON.stringify(record));
      await this.deps.evidence.publish(evidenceKey, bytes, "application/json", signal);
      await this.deps.reviews.append(record);
    }
    return {
      status: "review",
      operationId: pipeline.operationId,
      reviewId,
      code: record.failure.code,
      evidenceKey,
      automaticRetry: false,
    };
  }

  private record(target: {
    request: ReviewRequest;
    reviewId: string;
    evidenceKey: string;
  }): ReviewRecord {
    const { pipeline, causeCode } = target.request;
    const code = ReviewCodeSchema.safeParse(causeCode).success ? causeCode : target.request.code;
    const address = this.deps.registry.get(pipeline.channel).productAddress(pipeline.url);
    const identity = { requestId: pipeline.runId, observationId: pipeline.operationId };
    return ReviewRecordSchema.parse({
      schemaVersion: 1,
      reviewId: target.reviewId,
      occurredAt: new Date().toISOString(),
      observation: {
        schemaVersion: 1,
        ...identity,
        brandId: pipeline.brandId,
        sourceId: pipeline.sourceId,
        listingId: address.listingId,
        variantId: address.variantId,
      },
      failure: {
        schemaVersion: 1,
        ...identity,
        operationId: pipeline.operationId,
        inputFingerprint: sha256(Buffer.from(JSON.stringify(pipeline))),
        stage: "pipeline.product",
        category: CATEGORY_BY_AREA[String(code).split(".")[0] ?? ""] ?? "PROCESSING",
        code,
        executionFact: target.request.executionFact ?? "unknown",
        evidenceKey: target.evidenceKey,
        blockedBy: null,
        automaticRetry: false,
      },
      rawError: { name: "ProductPipeline", message: code, stack: null, details: target.request },
      candidate: null,
      inspection: { kind: "none" },
    });
  }
}
