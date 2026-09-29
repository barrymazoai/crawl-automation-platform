import type { Inspection, WorkflowStarter } from "@crawl-automation/app";
import type {
  CollectionSubmission,
  CollectionWorkflowInput,
  DeliveryTarget,
} from "@crawl-automation/v3-contracts";
import type { Client } from "@temporalio/client";
import { inspectExecution, inspectionIssue } from "./inspect-execution.js";

const CALL_DEADLINE_MS = 15_000;

/** Starts brand collections on Temporal and inspects them. */
export class TemporalWorkflowStarter implements WorkflowStarter {
  constructor(private readonly client: Client) {}

  async start(
    target: DeliveryTarget,
    submission: CollectionSubmission,
    input: CollectionWorkflowInput,
  ): Promise<void> {
    await this.withDeadline(() =>
      this.client.workflow.start(target.workflowType, {
        workflowId: submission.workflowId,
        taskQueue: target.taskQueue,
        args: [input],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "FAIL",
        // A brand waits for its whole catalog, so it has no execution deadline; each Activity has its own.
        ...(target.workflowType === "BrandCollectionWorkflow"
          ? {}
          : { workflowExecutionTimeout: "30 minutes" }),
      }),
    );
  }

  async inspect(target: DeliveryTarget, submission: CollectionSubmission): Promise<Inspection> {
    try {
      return await this.withDeadline(() => inspectExecution(this.client, target, submission));
    } catch (error) {
      return inspectionIssue(error);
    }
  }

  private withDeadline<Result>(call: () => Promise<Result>): Promise<Result> {
    return this.client.connection.withDeadline(Date.now() + CALL_DEADLINE_MS, call);
  }
}
