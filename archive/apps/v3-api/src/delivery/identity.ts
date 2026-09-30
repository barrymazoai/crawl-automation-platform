import { createHash } from "node:crypto";
import { CollectionWorkflowInput, type CollectionSubmission } from "@crawl-automation/v3-contracts";

export function workflowInput(submission: CollectionSubmission): CollectionWorkflowInput {
  return CollectionWorkflowInput.parse({ version: 1, requestId: submission.requestId, snapshot: submission.snapshot });
}
export function inputHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(CollectionWorkflowInput.parse(input))).digest("hex");
}
