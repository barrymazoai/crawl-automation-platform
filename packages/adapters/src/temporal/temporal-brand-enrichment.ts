import type { BrandEnrichmentGateway } from "@crawl-automation/app";
import {
  brandProductsRetryWorkflowId,
  type BrandProductsRetryRequest,
  type BrandEnrichmentWorkflowSettings,
} from "@crawl-automation/v3-contracts";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
} from "@temporalio/client";

/** Adapter: manual intake to a unique Temporal workflow; never restarts a terminal business run. */
export class TemporalBrandEnrichment implements BrandEnrichmentGateway {
  constructor(
    private readonly client: Client,
    private readonly settings: BrandEnrichmentWorkflowSettings,
  ) {}
  async start(runId: string): Promise<void> {
    try {
      await this.client.workflow.start("BrandEnrichmentWorkflow", {
        workflowId: `brand-enrichment-${runId}`,
        taskQueue: this.settings.taskQueue,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
        retry: { maximumAttempts: 1 },
        args: [{ runId, settings: this.settings }],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        throw error;
      }
    }
  }
  async startProductsRetry(input: BrandProductsRetryRequest): Promise<void> {
    await this.client.workflow.start("BrandProductsRetryWorkflow", {
      workflowId: brandProductsRetryWorkflowId(input),
      taskQueue: this.settings.taskQueue,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowIdConflictPolicy: "FAIL",
      retry: { maximumAttempts: 1 },
      args: [{ ...input, settings: this.settings }],
    });
  }
  describeProductsRetry(input: BrandProductsRetryRequest) {
    return this.describeWorkflow(brandProductsRetryWorkflowId(input));
  }
  async cancel(runId: string): Promise<void> {
    await this.client.workflow.getHandle(`brand-enrichment-${runId}`).cancel();
  }
  describe(runId: string): Promise<{ status: string } | null> {
    return this.describeWorkflow(`brand-enrichment-${runId}`);
  }
  private async describeWorkflow(workflowId: string): Promise<{ status: string } | null> {
    try {
      return {
        status: (await this.client.workflow.getHandle(workflowId).describe()).status.name,
      };
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return null;
      }
      throw error;
    }
  }
}
