import { proxyActivities } from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/common";
import { OcrInputSchema, assertOcrCompatibility } from "@crawl-automation/v3-contracts";
import type { Activities } from "../runners/activities.js";
import {
  QUEUES,
  SUPPORTED,
  type OcrInput,
  type PilotOutcome,
  type ReviewCode,
  type Review,
} from "../contracts/index.js";

const ocr = proxyActivities<Pick<Activities, "ocrFile">>({
  taskQueue: QUEUES.ocr,
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});
const handoff = proxyActivities<Pick<Activities, "verifyOcr" | "recordReview">>(
  {
    taskQueue: QUEUES.handoff,
    startToCloseTimeout: "10 seconds",
    // Only read-only verification and idempotent registration may be re-delivered.
    retry: {
      maximumAttempts: 3,
      initialInterval: "200 milliseconds",
      maximumInterval: "1 second",
    },
  },
);
const consumer = proxyActivities<Pick<Activities, "consumeOcr">>({
  taskQueue: QUEUES.consume,
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 1 },
});

export async function SingleFilePilot(input: OcrInput): Promise<PilotOutcome> {
  // Deployment/contract incompatibility is not a product failure. Reject before
  // scheduling an Activity or creating a business Review entry.
  try { input = OcrInputSchema.parse(input); assertOcrCompatibility(input, SUPPORTED); }
  catch { throw ApplicationFailure.nonRetryable("Input is incompatible with this P0 deployment", "RUNTIME.INCOMPATIBLE_CONSUMER"); }
  async function review(
    code: ReviewCode,
    stage: Review["stage"],
  ): Promise<PilotOutcome> {
    const reviewKey = await handoff.recordReview({
      schemaVersion: 1,
      requestId: input.requestId,
      category: code === "INPUT.CONFLICT" ? "IDENTITY" : code === "EXECUTION.OUTCOME_UNKNOWN" ? "PROCESSING" : "ARTIFACT",
      blockedBy: null,
      operationId: input.operationId,
      observationId: input.observationId,
      inputFingerprint: input.inputFingerprint,
      stage,
      code,
      executionFact: "unknown",
      evidenceKey: `completions/${input.operationId}.json`,
      automaticRetry: false,
    });
    return { businessOutcome: "review", reviewKey, code };
  }
  let completion;
  try {
    completion = await ocr.ocrFile(input);
  } catch {
    // A lost Activity response is not permission to submit OCR again.
    let checked;
    try {
      checked = await handoff.verifyOcr(input);
    } catch {
      return review("HANDOFF.UNAVAILABLE", "handoff");
    }
    if (checked.status === "unverified") return review(checked.code, "ocr");
    completion = checked.completion;
  }
  try {
    const characterCount = await consumer.consumeOcr(input, completion);
    return { businessOutcome: "processed", completion, characterCount };
  } catch {
    return review("EVIDENCE.INCOMPLETE", "consume");
  }
}
