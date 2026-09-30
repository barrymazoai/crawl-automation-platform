import type { ReviewRecord } from "@crawl-automation/v3-contracts";

/** A complete Review record with private canaries in its raw error and candidate. */
export function reviewFixture(reviewId = "review-001"): ReviewRecord {
  return {
    schemaVersion: 1,
    reviewId,
    occurredAt: "2026-09-06T00:00:00.000Z",
    failure: failureFixture(),
    observation: observationFixture(),
    rawError: {
      name: "ResultError",
      message: "Original private error",
      stack: "private-stack-canary",
      details: { authorization: "private-token-canary" },
    },
    candidate: {
      schema: "product-candidate/1",
      value: {
        formula: "Complete Formula",
        ingredients: ["A", "B"],
        note: "candidate-private-canary",
      },
    },
    inspection: { kind: "none" },
  };
}

function failureFixture(): ReviewRecord["failure"] {
  return {
    schemaVersion: 1,
    requestId: "request-001",
    observationId: "observation-001",
    operationId: "operation-001",
    inputFingerprint: "a".repeat(64),
    stage: "ocr.file/register",
    category: "PROCESSING",
    code: "RESULT.REGISTRATION_UNKNOWN",
    executionFact: "executed",
    evidenceKey: "evidence/operation-001/complete.json",
    blockedBy: null,
    automaticRetry: false,
  };
}

function observationFixture(): ReviewRecord["observation"] {
  return {
    schemaVersion: 1,
    requestId: "request-001",
    observationId: "observation-001",
    brandId: "brand-001",
    sourceId: "source-001",
    listingId: "listing-001",
    variantId: null,
  };
}
