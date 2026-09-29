import type { TextInput } from "@crawl-automation/v3-contracts";
import type { ExecutionFact } from "../errors.js";

export interface ReviewFailure {
  stage: string;
  code: string;
  executionFact: ExecutionFact;
  evidenceKey: string;
  /** The upstream operation that blocked this one, when it never ran because of it. */
  blockedBy: string | null;
}

/** The `failure` part of a text task's Review: the task's identity plus what went wrong. */
export function textReviewFailure(input: TextInput, failure: ReviewFailure) {
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    observationId: input.observationId,
    operationId: input.operationId,
    inputFingerprint: input.inputFingerprint,
    stage: failure.stage,
    category: "PROCESSING",
    code: failure.code,
    executionFact: failure.executionFact,
    evidenceKey: failure.evidenceKey,
    blockedBy: failure.blockedBy,
    automaticRetry: false,
  };
}
