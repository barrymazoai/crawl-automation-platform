import {
  TextActivityOutcomeSchema,
  TextInputSchema,
  TextReceiptOutcomeSchema,
  type TextActivityOutcome,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import { ApplicationFailure, isCancellation } from "@temporalio/workflow";
import { isAdmissionFailure, type LabelRun } from "./label-run.js";
import { sameJson } from "./same.js";
import type { State } from "./label-model.js";
import { isHeartbeatFailure } from "./activity-heartbeat.js";

/**
 * One text task: the model once, then the receipt, which confirms the result (or its Review) from durable evidence.
 * When the call's outcome is lost the receipt only inspects; the model is never called twice.
 */
export async function runText(run: LabelRun, at: { id: string; task: TextInput }): Promise<State> {
  const { id, task } = at;
  let outcome: TextActivityOutcome | null = null;
  try {
    outcome = TextActivityOutcomeSchema.parse(await run.call("model", "interpretText", task));
  } catch (error) {
    if (isCancellation(error) || isAdmissionFailure(error) || isHeartbeatFailure(error)) {
      throw error;
    }
    // Only read-only reconciliation follows.
  }
  const receipt = TextReceiptOutcomeSchema.parse(
    await run.call("activities", "resolveTextReceipt", { input: task, outcome }),
  );
  const own =
    receipt.status === "registered"
      ? sameJson(TextInputSchema.parse(receipt.registration.input), task)
      : receipt.operationId === task.operationId;
  if (!own) {
    throw ApplicationFailure.nonRetryable(
      "Text receipt identity mismatch",
      "TEXT_RECEIPT.IDENTITY_CONFLICT",
    );
  }
  return receipt.status === "registered"
    ? { id, status: "registered" }
    : { id, status: "review", reviewId: receipt.reviewId };
}
