import { productRunWorkflowId, type RunExecution, type RunExecutions } from "@crawl-automation/app";
import { WorkflowNotFoundError, type Client } from "@temporalio/client";

const CALL_DEADLINE_MS = 15_000;

/** A product run's workflow as Temporal shows it: its status, and its result once it completed. */
export class TemporalRunExecutions implements RunExecutions {
  constructor(private readonly client: Client) {}

  async execution(runId: string): Promise<RunExecution> {
    const handle = this.client.workflow.getHandle(productRunWorkflowId(runId));
    try {
      const described = await this.withDeadline(() => handle.describe());
      const status = described.status.name;
      const result = status === "COMPLETED" ? await this.withDeadline(() => handle.result()) : null;
      return { status, result };
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return { status: "MISSING", result: null };
      }
      throw error;
    }
  }

  private withDeadline<Result>(call: () => Promise<Result>): Promise<Result> {
    return this.client.connection.withDeadline(Date.now() + CALL_DEADLINE_MS, call);
  }
}
