import { createHash } from "node:crypto";
import {
  CollectionWorkflowInput,
  Id,
  type CollectionSubmission,
  type DeliveryIssue,
  type DeliveryReceipt,
} from "@crawl-automation/v3-contracts";
import type { ExecutionProof, Inspection } from "./ports.js";

/** An observed identity or chain violation is not a network failure; later checks never erase it. */
const isolationIssues = new Set<DeliveryIssue>([
  "IDENTITY_MISMATCH",
  "RUN_CHANGED",
  "CHAIN_CONTINUED",
]);

export const terminalStatuses = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
]);

export function workflowInput(submission: CollectionSubmission): CollectionWorkflowInput {
  return CollectionWorkflowInput.parse({
    version: 1,
    requestId: submission.requestId,
    snapshot: submission.snapshot,
  });
}

export function inputHash(input: unknown): string {
  const canonical = JSON.stringify(CollectionWorkflowInput.parse(input));
  return createHash("sha256").update(canonical).digest("hex");
}

function closeUnproven(inspection: ExecutionProof): boolean {
  const eventIdValid = /^[1-9][0-9]*$/.test(inspection.terminalEventId ?? "");
  const closedAtValid = Number.isFinite(Date.parse(inspection.closedAt ?? ""));
  return !eventIdValid || !closedAtValid;
}

/** The issue to record for an inspection, or null when it is a clean proof. */
export function proofIssue(current: DeliveryReceipt, inspection: Inspection): DeliveryIssue | null {
  if (current.lastIssue && isolationIssues.has(current.lastIssue)) {
    return current.lastIssue;
  }
  if (typeof inspection === "string") {
    return inspection;
  }
  return identityIssue(current, inspection) ?? chainIssue(inspection);
}

/** The execution must be the one this delivery started. */
function identityIssue(current: DeliveryReceipt, proof: ExecutionProof): DeliveryIssue | null {
  if (proof.inputHash !== current.inputHash || !Id.safeParse(proof.runId).success) {
    return "IDENTITY_MISMATCH";
  }
  if (current.runId && current.runId !== proof.runId) {
    return "RUN_CHANGED";
  }
  return null;
}

/** A continued chain or an unproven close is not an ending. */
function chainIssue(proof: ExecutionProof): DeliveryIssue | null {
  if (proof.continued || proof.status === "CONTINUED_AS_NEW") {
    return "CHAIN_CONTINUED";
  }
  if (terminalStatuses.has(proof.status) && closeUnproven(proof)) {
    return "UNCONFIRMED_TERMINAL";
  }
  return null;
}
