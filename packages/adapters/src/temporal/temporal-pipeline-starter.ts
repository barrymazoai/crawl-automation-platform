import type { PipelineStarter } from "@crawl-automation/app";
import type { ProductPipelineInput } from "@crawl-automation/workflows";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";

const CALL_DEADLINE_MS = 15_000;

/** Starts one product's pipeline workflow on its task queue, exactly once per workflow ID. */
export class TemporalPipelineStarter implements PipelineStarter {
  constructor(private readonly client: Client) {}

  async start(workflowId: string, input: ProductPipelineInput): Promise<{ startedRunId: string }> {
    try {
      const handle = await this.withDeadline(() =>
        this.client.workflow.start("ProductPipelineWorkflow", {
          workflowId,
          taskQueue: input.queues.activities,
          args: [input],
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          workflowIdConflictPolicy: "FAIL",
          // One product: capture, plan and label reading finish well within this.
          workflowExecutionTimeout: "6 hours",
        }),
      );
      return { startedRunId: handle.firstExecutionRunId };
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        throw error;
      }
      // An earlier request started it; its record was not written yet.
      const described = await this.withDeadline(() =>
        this.client.workflow.getHandle(workflowId).describe(),
      );
      return { startedRunId: described.runId };
    }
  }

  private withDeadline<Result>(call: () => Promise<Result>): Promise<Result> {
    return this.client.connection.withDeadline(Date.now() + CALL_DEADLINE_MS, call);
  }
}
