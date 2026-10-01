import { errorCodeOf, isAppError, recordRecovery } from "@crawl-automation/platform";
import { buildStepReview, enrichmentErrors, enrichmentHash } from "@crawl-automation/processing";
import type { EnrichmentSubject, ReviewRecord } from "@crawl-automation/v3-contracts";
import type { EnrichmentDependencies } from "./ports.js";
import { enrichmentKey } from "./evidence.js";

type Failure = {
  subject: EnrichmentSubject;
  inputHash: string;
  error: unknown;
  executionFact: "not_executed" | "executed" | "unknown";
  candidate: ReviewRecord["candidate"];
  inputKey: string | null;
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

function reviewRecord({ subject, inputHash, error, executionFact, candidate, inputKey }: Failure) {
  const code = errorCodeOf(error) ?? enrichmentErrors.code("ENRICH.UNCLASSIFIED");
  const record = buildStepReview({
    reviewId: `enrich-${inputHash}`,
    observation: subject.observation,
    task: {
      requestId: subject.observation.requestId,
      observationId: subject.observation.observationId,
      operationId: subject.collectionOperationId,
      inputFingerprint: inputHash,
    },
    stage: "product.enrich",
    category: "PROCESSING",
    code,
    fact: executionFact,
    evidenceKey: enrichmentKey(inputHash, "review.json"),
    blockedBy: null,
    error: {
      name: error instanceof Error ? error.name : "Error",
      details: {
        ...(isAppError(error) ? error.details : {}),
        subject,
        inputHash,
        inputKey,
        responseKey: candidate ? enrichmentKey(inputHash, "response.txt") : null,
      },
    },
    candidate,
    inspection: { kind: "none" },
  });
  record.rawError.message = error instanceof Error ? error.message : String(error);
  return record;
}
