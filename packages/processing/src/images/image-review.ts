import type { ObjectStore } from "@crawl-automation/platform";
import {
  observationIdentity,
  type FileAcquireInput,
  type FileOcrPlan,
  type ImageOcrPrepareOutcome,
} from "@crawl-automation/v3-contracts";
import { keepAndRecordReview, type ReviewLedger } from "../step/kept-review.js";
import { buildStepReview, newReviewId } from "../step/step-review.js";
import { imageFailure } from "./image-errors.js";

/** Codes a Review may keep as they are; anything else is recorded as unresolved. */
const KEPT_CODE = /^(ACQUIRE|SOURCE|ARTIFACT|INPUT|RUNTIME|IMAGE)\.[A-Z_]+$/;

interface ReviewPlace {
  deps: { local: ObjectStore; reviews: ReviewLedger };
  input: FileAcquireInput;
  plan: FileOcrPlan;
}

/** The Review of an image whose OCR task could not be prepared, kept locally first, then in the ledger. */
export async function imageReview(
  place: ReviewPlace,
  failureCode: string | null,
): Promise<Extract<ImageOcrPrepareOutcome, { status: "review" }>> {
  const { input, plan } = place;
  const code = failureCode && KEPT_CODE.test(failureCode) ? failureCode : "ACQUIRE.UNRESOLVED";
  const reviewId = newReviewId("acquire");
  const key = `acquisition-reviews/${reviewId}.json`;
  const review = buildStepReview({
    reviewId,
    task: input,
    observation: observationIdentity(input),
    stage: "image.ocr-input",
    category: "ARTIFACT",
    code,
    fact: "unknown",
    evidenceKey: key,
    blockedBy: null,
    error: { name: "AcquisitionFailure", details: { input } },
    candidate: { schema: "acquisition-evidence/1", value: { plan } },
    inspection: { kind: "none" },
  });
  const unverified = () => imageFailure("ACQUIRE.REVIEW_UNVERIFIED");
  await keepAndRecordReview(
    review,
    { local: place.deps.local, key, reviews: place.deps.reviews },
    { localUnverified: unverified, reviewUnverified: unverified },
  );
  return {
    status: "review",
    operationId: input.operationId,
    reviewId,
    evidenceKey: key,
    code,
    automaticRetry: false,
  };
}
