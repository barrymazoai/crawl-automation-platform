import { Id, type DeliveryIssue, type DeliveryReceipt } from "@crawl-automation/v3-contracts";
import type { ExecutionProof } from "./port.js";

// An observed identity/chain violation is not a transient connectivity failure.
// Ordinary reconciliation may never erase this isolation decision.
const isolationIssues = new Set<DeliveryIssue>(["IDENTITY_MISMATCH", "RUN_CHANGED", "CHAIN_CONTINUED"]);
export const terminalStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"]);
export function proofIssue(current: DeliveryReceipt, proof: ExecutionProof | DeliveryIssue): DeliveryIssue | null {
  if (current.lastIssue && isolationIssues.has(current.lastIssue)) return current.lastIssue;
  if (typeof proof === "string") return proof;
  if (proof.inputHash !== current.inputHash || !Id.safeParse(proof.runId).success) return "IDENTITY_MISMATCH";
  if (current.runId && current.runId !== proof.runId) return "RUN_CHANGED";
  if (proof.continued || proof.status === "CONTINUED_AS_NEW") return "CHAIN_CONTINUED";
  if (terminalStatuses.has(proof.status) && (!proof.closedAt || !/^[1-9][0-9]*$/.test(proof.terminalEventId ?? "") || !Number.isFinite(Date.parse(proof.closedAt))))
    return "UNCONFIRMED_TERMINAL";
  return null;
}
