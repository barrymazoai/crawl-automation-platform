import type { SubmissionRepository } from "../submissions/port.js";
import { InspectionError, type DeliveryJournal, type WorkflowGateway } from "./port.js";
import { inputHash, workflowInput } from "./identity.js";

// A bounded handoff operation, not a scheduler. Call again to RECONCILE, not re-run.
export class DeliveryCoordinator {
  constructor(
    private readonly submissions: SubmissionRepository,
    private readonly journal: DeliveryJournal,
    private readonly gateway: WorkflowGateway,
  ) {}

  async reconcile(requestId: string) {
    const submission = await this.submissions.get(requestId);
    const input = workflowInput(submission);
    const intent = await this.journal.begin(requestId, this.gateway.target, inputHash(input));
    if (intent.receipt.state === "CLOSED") return intent.receipt;
    if (intent.mayStart) {
      // Only the transaction that created the intent may send Start once.
      // If this process dies before/after Start, other processes inspect only.
      try { await this.gateway.start(submission, input); }
      catch { /* Includes lost response and AlreadyStarted: inspect actual history. */ }
    }
    let proof;
    try { proof = await this.gateway.inspect(submission); }
    catch (error) {
      return this.journal.record(requestId, error instanceof InspectionError ? error.issue : "UNAVAILABLE");
    }
    return this.journal.record(requestId, proof);
  }
}
