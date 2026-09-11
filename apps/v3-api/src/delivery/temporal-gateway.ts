import { Client, WorkflowNotFoundError } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { DeliveryTarget, ExecutionStatus, type CollectionSubmission, type CollectionWorkflowInput } from "@crawl-automation/v3-contracts";
import { inputHash } from "./identity.js";
import { InspectionError, type ExecutionProof, type WorkflowGateway } from "./port.js";

// Client lifecycle, TLS and endpoint selection belong to the composition root.
export class TemporalGateway implements WorkflowGateway {
  readonly target: DeliveryTarget;
  constructor(private readonly client: Client, target: DeliveryTarget) {
    this.target = DeliveryTarget.parse(target);
    if (client.workflow.options.namespace !== target.namespace) throw new Error("Temporal namespace mismatch");
  }
  async start(submission: CollectionSubmission, input: CollectionWorkflowInput) {
    await this.client.connection.withDeadline(Date.now() + 15000, () => this.client.workflow.start(this.target.workflowType, {
      workflowId: submission.workflowId,
      taskQueue: this.target.taskQueue,
      args: [input],
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowIdConflictPolicy: "FAIL",
      // No workflow retry/cron or automatic terminate-and-replace policy.
      workflowExecutionTimeout: "30 minutes",
    }));
  }
  async inspect(submission: CollectionSubmission): Promise<ExecutionProof> {
    try {
      return await this.client.connection.withDeadline(Date.now() + 15000, async () => {
      const description = await this.client.workflow.getHandle(submission.workflowId).describe();
      const status = ExecutionStatus.parse(description.status.name);
      const execution = { workflowId: submission.workflowId, runId: description.runId };
      const request = { namespace: this.target.namespace, execution, maximumPageSize: 1, waitNewEvent: false };
      const first = await this.client.connection.workflowService.getWorkflowExecutionHistory(request);
      const started = first.history?.events?.[0]?.workflowExecutionStartedEventAttributes;
      if (!started || started.workflowType?.name !== this.target.workflowType || started.taskQueue?.name !== this.target.taskQueue || started.input?.payloads?.length !== 1)
        throw new InspectionError("IDENTITY_MISMATCH");
      let hash: string;
      try { hash = inputHash(defaultPayloadConverter.fromPayload(started.input.payloads[0]!)); }
      catch { throw new InspectionError("IDENTITY_MISMATCH"); }
      // A retry/reset/Continue-As-New descendant is not proof that the original chain ended.
      // Missing ancestry is not evidence of a root execution. No guessing across reset/retry.
      if (!started.firstExecutionRunId || !started.originalExecutionRunId) throw new InspectionError("UNCONFIRMED_TERMINAL");
      const continued = !!started.continuedExecutionRunId || (started.attempt ?? 1) > 1 ||
        started.firstExecutionRunId !== description.runId || started.originalExecutionRunId !== description.runId;
      const proof: ExecutionProof = { runId: description.runId, inputHash: hash, status, continued, terminalEventId: null, closedAt: null };
      if (status === "RUNNING" || status === "CONTINUED_AS_NEW") return proof;
      // Brand descendants use ABANDON. A failed/cancelled/timed-out parent is NOT proof
      // that browser/provider work stopped; keep intake guard for evidence-based review.
      if(this.target.workflowType==="BrandCollectionWorkflow"&&status!=="COMPLETED")throw new InspectionError("UNCONFIRMED_TERMINAL");
      const closed = await this.client.connection.workflowService.getWorkflowExecutionHistory({ ...request, historyEventFilterType: 2 });
      const event = closed.history?.events?.[0];
      const attribute = event && ({
        COMPLETED: event.workflowExecutionCompletedEventAttributes,
        FAILED: event.workflowExecutionFailedEventAttributes,
        CANCELLED: event.workflowExecutionCanceledEventAttributes,
        TERMINATED: event.workflowExecutionTerminatedEventAttributes,
        TIMED_OUT: event.workflowExecutionTimedOutEventAttributes,
      })[status];
      if (!event || !attribute || !event.eventTime || !event.eventId) throw new InspectionError("UNCONFIRMED_TERMINAL");
      if(this.target.workflowType==="BrandCollectionWorkflow"){
        const payloads=event.workflowExecutionCompletedEventAttributes?.result?.payloads;
        const result=payloads?.length===1?defaultPayloadConverter.fromPayload(payloads[0]!):null;
        if(!result||typeof result!=="object"||!("codec" in result)||result.codec!=="brand-collection-settled/1"||!("requestId" in result)||result.requestId!==submission.requestId||!("settled" in result)||result.settled!==true)
          throw new InspectionError("UNCONFIRMED_TERMINAL");
      }
      if ("newExecutionRunId" in attribute && attribute.newExecutionRunId) proof.continued = true;
      proof.terminalEventId = event.eventId.toString();
      proof.closedAt = new Date(Number(event.eventTime.seconds) * 1000 + Number(event.eventTime.nanos ?? 0) / 1e6).toISOString();
      // Re-read current execution: a concurrent reset/new run invalidates this close proof.
      if ((await this.client.workflow.getHandle(submission.workflowId).describe()).runId !== description.runId)
        throw new InspectionError("RUN_CHANGED");
      return proof;
      });
    } catch (error) {
      if (error instanceof InspectionError) throw error;
      if (error instanceof WorkflowNotFoundError || (error as { code?: number })?.code === 5)
        throw new InspectionError("NOT_FOUND");
      throw new InspectionError("UNAVAILABLE");
    }
  }
}
