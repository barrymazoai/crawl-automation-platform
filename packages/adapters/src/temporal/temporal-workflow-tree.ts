import type { WorkflowMember, WorkflowStatusReader, WorkflowTree } from "@crawl-automation/app";
import { WorkflowNotFoundError, type Client } from "@temporalio/client";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

/**
 * Every workflow of a run, found by `RootWorkflowId`. This includes children started with ABANDON, such
 * as product and variant workflows, which a cancel of the root alone would miss.
 */
export class TemporalWorkflowTree implements WorkflowTree, WorkflowStatusReader {
  constructor(private readonly client: Client) {}

  async members(rootWorkflowId: string): Promise<WorkflowMember[]> {
    if (!ID_PATTERN.test(rootWorkflowId)) {
      return [];
    }
    const members: WorkflowMember[] = [];
    for await (const execution of this.client.workflow.list({
      query: `RootWorkflowId = "${rootWorkflowId}"`,
    })) {
      members.push({
        workflowId: execution.workflowId,
        type: execution.type,
        status: execution.status.name,
        closedAt: execution.closeTime ?? null,
      });
    }
    return members;
  }

  async cancel(workflowId: string): Promise<void> {
    await this.client.workflow.getHandle(workflowId).cancel();
  }

  async status(workflowId: string): Promise<WorkflowMember | null> {
    try {
      const description = await this.client.workflow.getHandle(workflowId).describe();
      return {
        workflowId,
        type: description.type,
        status: description.status.name,
        closedAt: description.closeTime ?? null,
      };
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return null;
      }
      throw error;
    }
  }
}
