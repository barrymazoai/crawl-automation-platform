import type { EnrichmentStarter } from "@crawl-automation/app";
import { enrichmentHash } from "@crawl-automation/processing";
import { EnrichmentRequestSchema, type EnrichmentRequest } from "@crawl-automation/v3-contracts";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";

/** Manual enrichment dispatch alongside its repository; never restarts an existing workflow. */
export class EnrichmentWorkflowStarter implements EnrichmentStarter {
  constructor(
    private readonly client: Client,
    private readonly activitiesQueue: string,
  ) {}

  async start(raw: EnrichmentRequest): Promise<{ workflowId: string }> {
    const request = EnrichmentRequestSchema.parse(raw);
    const workflowId = `product-enrichment-${enrichmentHash(request)}`;
    try {
      await this.client.connection.withDeadline(Date.now() + 15_000, () =>
        this.client.workflow.start("ProductEnrichmentWorkflow", {
          workflowId,
          taskQueue: this.activitiesQueue,
          args: [{ request, activitiesQueue: this.activitiesQueue }],
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          workflowIdConflictPolicy: "FAIL",
          retry: { maximumAttempts: 1 },
        }),
      );
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        throw error;
      }
    }
    return { workflowId };
  }
}
