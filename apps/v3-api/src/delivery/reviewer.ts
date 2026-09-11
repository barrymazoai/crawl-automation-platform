import { Id } from "@crawl-automation/v3-contracts";
import type { SubmissionRepository } from "../submissions/port.js";
import { InspectionError, type DeliveryJournal, type WorkflowGateway } from "./port.js";
import { proofIssue, terminalStatuses } from "./proof-policy.js";
import { inputHash, workflowInput } from "./identity.js";

// Deliberately has no begin, record, start, reset or release capabilities.
export class DeliveryReviewer {
  constructor(
    private readonly submissions: Pick<SubmissionRepository, "get">,
    private readonly journal: Pick<DeliveryJournal, "get">,
    private readonly gateway: Pick<WorkflowGateway, "target" | "inspect">,
  ) {}
  async inspect(requestId: string) {
    requestId = Id.parse(requestId);
    const submission = await this.submissions.get(requestId);
    const receipt = await this.journal.get(requestId);
    const base = { requestId, workflowId: submission.workflowId, observedAt: new Date().toISOString(), receipt, mutatesState: false as const };
    if (!receipt) return { ...base, decision: "HOLD", issue: "NO_INTENT", remote: null };
    if (JSON.stringify(receipt.target) !== JSON.stringify(this.gateway.target) || receipt.inputHash !== inputHash(workflowInput(submission)))
      return { ...base, decision: "HOLD", issue: "LOCAL_IDENTITY_MISMATCH", remote: null };
    try {
      const remote = await this.gateway.inspect(submission);
      const issue = proofIssue(receipt, remote);
      return { ...base, remote, issue, decision: issue ? "HOLD" : receipt.state === "CLOSED" ? "RECORDED_CLOSED" :
        terminalStatuses.has(remote.status) ? "READY_FOR_RECONCILIATION" : "WAITING_REMOTE" };
    } catch (error) {
      return { ...base, decision: "HOLD", remote: null, issue: proofIssue(receipt, error instanceof InspectionError ? error.issue : "UNAVAILABLE") };
    }
  }
}
