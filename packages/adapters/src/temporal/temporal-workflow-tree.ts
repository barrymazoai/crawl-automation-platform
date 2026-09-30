import type {
  StopEvidence,
  StopEvidenceReader,
  WorkflowMember,
  WorkflowTree,
} from "@crawl-automation/app";
import { WorkflowNotFoundError, type Client } from "@temporalio/client";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

/**
 * Every workflow of a run, found by `RootWorkflowId`. This includes children started with ABANDON, such
 * as product and variant workflows, which a cancel of the root alone would miss.
 */
export class TemporalWorkflowTree implements WorkflowTree, StopEvidenceReader {
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

  /** Status, close time and pending Activities of one exact execution; null when Temporal cannot find it. */
  async stopEvidence(workflowId: string, runId: string): Promise<StopEvidence | null> {
    try {
      const description = await this.client.workflow.getHandle(workflowId, runId).describe();
      return {
        workflowId,
        status: description.status.name,
        closedAt: description.closeTime ?? null,
        pendingActivities: description.raw.pendingActivities?.length ?? 0,
      };
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        // WorkflowNotFoundError (gRPC NOT_FOUND) is the expected absent execution; other failures propagate.
        return null;
      }
      throw error;
    }
  }
}
