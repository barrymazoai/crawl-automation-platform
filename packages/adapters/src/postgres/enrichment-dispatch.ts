import type { EnrichmentStarter } from "@crawl-automation/app";
import { enrichmentHash } from "@crawl-automation/processing";
import {
  EnrichmentRequestSchema,
  SHARED_ENRICHMENT_PROTOCOL,
  type EnrichmentRequest,
} from "@crawl-automation/v3-contracts";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";

/**
 * Manual enrichment dispatch alongside its repository; never restarts an existing workflow of the same protocol.
 * The protocol is in the ID so that a product enriched under an older one can be enriched again (owner 2026-10-26).
 */
export class EnrichmentWorkflowStarter implements EnrichmentStarter {
  constructor(
    private readonly client: Client,
    private readonly activitiesQueue: string,
  ) {}

  async start(raw: EnrichmentRequest): Promise<{ workflowId: string }> {
    const request = EnrichmentRequestSchema.parse(raw);
    const workflowId = `product-enrichment-${enrichmentHash([SHARED_ENRICHMENT_PROTOCOL, request])}`;
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
