import type {
  CollectionSubmission, CollectionWorkflowInput, DeliveryIssue, DeliveryReceipt,
  DeliveryTarget, ExecutionStatus,
} from "@crawl-automation/v3-contracts";

export interface ExecutionProof {
  runId: string;
  inputHash: string;
  status: ExecutionStatus;
  continued: boolean;
  terminalEventId: string | null;
  closedAt: string | null;
}
export interface WorkflowGateway {
  readonly target: DeliveryTarget;
  start(submission: CollectionSubmission, input: CollectionWorkflowInput): Promise<void>;
  inspect(submission: CollectionSubmission): Promise<ExecutionProof>;
}
export class InspectionError extends Error {
  constructor(readonly issue: DeliveryIssue) { super(issue); }
}
export interface DeliveryJournal {
  begin(requestId: string, target: DeliveryTarget, inputHash: string): Promise<{ mayStart: boolean; receipt: DeliveryReceipt }>;
  get(requestId: string): Promise<DeliveryReceipt | null>;
  record(requestId: string, proof: ExecutionProof | DeliveryIssue): Promise<DeliveryReceipt>;
}
