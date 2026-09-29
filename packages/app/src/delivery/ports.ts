import type {
  CollectionSubmission,
  CollectionWorkflowInput,
  DeliveryIssue,
  DeliveryReceipt,
  DeliveryTarget,
  ExecutionStatus,
} from "@crawl-automation/v3-contracts";

/** What Temporal shows about a started brand collection. */
export interface ExecutionProof {
  runId: string;
  inputHash: string;
  status: ExecutionStatus;
  continued: boolean;
  terminalEventId: string | null;
  closedAt: string | null;
}

/** An inspection either proves the execution's state or names the issue that prevented proof. */
export type Inspection = ExecutionProof | DeliveryIssue;

export interface WorkflowStarter {
  start(
    target: DeliveryTarget,
    submission: CollectionSubmission,
    input: CollectionWorkflowInput,
  ): Promise<void>;
  inspect(target: DeliveryTarget, submission: CollectionSubmission): Promise<Inspection>;
}

export interface DeliveryIntent {
  mayStart: boolean;
  receipt: DeliveryReceipt;
}

/** The durable record of each start: only the call that created the intent may start the workflow. */
export interface DeliveryJournal {
  begin(requestId: string, target: DeliveryTarget, inputHash: string): Promise<DeliveryIntent>;
  get(requestId: string): Promise<DeliveryReceipt | null>;
  record(requestId: string, inspection: Inspection): Promise<DeliveryReceipt>;
}

export interface ScanCursor {
  createdAt: string;
  requestId: string;
}

/** Accepted submissions that still need a start or a check, in creation order. */
export interface DeliveryScan {
  upperBound(): Promise<ScanCursor | null>;
  page(after: ScanCursor | null, through: ScanCursor, limit: number): Promise<ScanCursor[]>;
}

export interface SubmissionReader {
  get(requestId: string): Promise<CollectionSubmission>;
}
