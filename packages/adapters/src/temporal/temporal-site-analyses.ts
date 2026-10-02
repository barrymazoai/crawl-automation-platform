import {
  siteAnalysisErrors,
  type BrandScanPermit,
  type SiteAnalysisGateway,
} from "@crawl-automation/app";
import type { SiteAnalysis } from "@crawl-automation/v3-contracts";
import type { Client } from "@temporalio/client";
import { WorkflowNotFoundError, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

export class TemporalSiteAnalyses implements SiteAnalysisGateway {
  constructor(
    private readonly client: Client,
    private readonly permit: BrandScanPermit | undefined,
  ) {}
  async start(analysis: SiteAnalysis): Promise<void> {
    const permit = this.permit;
    if (!permit) {
      throw siteAnalysisErrors.create("SITE_ANALYSIS.NOT_CONFIGURED");
    }
    try {
      await this.client.workflow.start("SiteAnalysisWorkflow", {
        workflowId: `site-analysis-${analysis.analysisId}`,
        taskQueue: permit.taskQueue,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
        args: [
          {
            ...analysis,
            resources: {
              queue: permit.resourceQueue,
              maxWaitSeconds: permit.maxWaitSeconds,
              activities: {
                analyzeSiteInBrowser: [
                  { resourceId: permit.resourceId, units: 1 },
                  ...(permit.additionalResources ?? []),
                ],
              },
            },
          },
        ],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        throw error;
      }
    }
  }
  async failure(analysisId: string): Promise<string | null> {
    try {
      const description = await this.client.workflow
        .getHandle(`site-analysis-${analysisId}`)
        .describe();
      const status = description.status.name;
      return ["FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(status)
        ? `Workflow ${status.toLowerCase()}; automatic retry disabled`
        : null;
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return null;
      }
      throw error;
    }
  }
}
