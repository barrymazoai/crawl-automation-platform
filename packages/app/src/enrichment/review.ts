import { errorCodeOf, isAppError, recordRecovery } from "@crawl-automation/platform";
import { enrichmentErrors, enrichmentHash } from "@crawl-automation/processing";
import { ReviewRecordSchema, type EnrichmentSubject } from "@crawl-automation/v3-contracts";
import type { EnrichmentDependencies } from "./ports.js";

type Failure = {
  subject: EnrichmentSubject;
  inputHash: string;
  error: unknown;
  executionFact: "not_executed" | "executed" | "unknown";
};

export async function enrichmentReview(
  deps: Pick<EnrichmentDependencies, "publication" | "reviews">,
  failure: Failure,
) {
  const { inputHash, error } = failure;
  const reviewId = `enrich-${inputHash}`;
  const prior = await deps.reviews.read(reviewId);
  if (prior) {
    return { status: "review" as const, reviewId, code: prior.failure.code };
  }
  const record = reviewRecord(failure);
  await deps.publication.publish(
    record.failure.evidenceKey,
    Buffer.from(JSON.stringify(record)),
    "application/json",
    AbortSignal.timeout(20_000),
  );
  try {
    await deps.reviews.append(record);
  } catch (cause) {
    recordRecovery(cause, { operation: "enrichment.review-readback" });
  }
  if (enrichmentHash(await deps.reviews.read(reviewId)) !== enrichmentHash(record)) {
    throw enrichmentErrors.create("ENRICH.INTEGRITY", { cause: error });
  }
  return { status: "review" as const, reviewId, code: record.failure.code };
}

function reviewRecord({ subject, inputHash, error, executionFact }: Failure) {
  const code = errorCodeOf(error) ?? enrichmentErrors.code("ENRICH.UNCLASSIFIED");
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: `enrich-${inputHash}`,
    occurredAt: new Date().toISOString(),
    observation: subject.observation,
    failure: {
      schemaVersion: 1,
      requestId: subject.observation.requestId,
      observationId: subject.observation.observationId,
      operationId: subject.collectionOperationId,
      inputFingerprint: inputHash,
      stage: "product.enrich",
      category: "PROCESSING",
      code,
      executionFact,
      evidenceKey: `v3/product-enrichment/${inputHash}/review.json`,
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: null,
      details: { subject, inputHash, cause: isAppError(error) ? error.details : null },
    },
    candidate: null,
    inspection: { kind: "none" },
  });
}
