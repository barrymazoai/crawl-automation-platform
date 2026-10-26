import type { EnrichmentStarter } from "@crawl-automation/app";
import { enrichmentHash } from "@crawl-automation/processing";
import {
  EnrichmentRequestSchema,
  SHARED_ENRICHMENT_PROTOCOL,
  type EnrichmentRequest,
} from "@crawl-automation/v3-contracts";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";

/**
 * Manual enrichment dispatch alongside its repository. The protocol is in the ID so that a product enriched under an
 * older one can be enriched again (owner 2026-10-26). A running workflow is never started twice; an ended one may run
 * again on the owner's request, because the enrichment itself reuses a registered answer or a recorded Review and
 * never calls the model twice for a claimed input (30 re-runs on 2026-10-26 ended on a database timeout before any
 * claim and could not be run again).
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
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
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
