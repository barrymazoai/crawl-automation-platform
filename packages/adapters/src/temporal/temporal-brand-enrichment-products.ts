import { setTimeout } from "node:timers/promises";
import {
  brandEnrichmentErrors,
  type BrandProductExecution,
  type BrandScanStore,
  type PermitStore,
} from "@crawl-automation/app";
import { WorkflowFailedError, WorkflowNotFoundError, type Client } from "@temporalio/client";

/** Stops exact DTC work submitted by this run. Committed shared product-queue records keep their own lifecycle. */
export class TemporalBrandEnrichmentProducts implements BrandProductExecution {
  constructor(
    private readonly deps: {
      client: Client;
      scans: Pick<BrandScanStore, "cancel" | "get">;
      permits: PermitStore;
    },
  ) {}
  async stop(input: { analysisId: string; scanIds: string[] }): Promise<void> {
    await this.stopAnalysis(input.analysisId);
    await this.verifyReleased([`site-analysis-${input.analysisId}`]);
    if (!input.scanIds.length) {
      return;
    }
    await this.deps.scans.cancel({ scanIds: input.scanIds });
    for (let poll = 0; poll < 300; poll++) {
      const scans = await Promise.all(input.scanIds.map((id) => this.deps.scans.get(id)));
      const held = await this.deps.permits.heldBy(
        input.scanIds.flatMap((id) => [`browser-scan-${id}`, `brand-listing-${id}`]),
      );
      if (
        scans.every((scan) => scan && scan.state !== "queued" && scan.state !== "running") &&
        !held.length
      ) {
        return;
      }
      await setTimeout(1000);
    }
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.CLEANUP_PENDING", { details: input });
  }
  private async verifyReleased(workflowIds: string[]) {
    const held = await this.deps.permits.heldBy(workflowIds);
    if (held.length) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.CLEANUP_PENDING", {
        details: { workflowIds, permits: held.map((permit) => permit.permitId) },
      });
    }
  }
  private async stopAnalysis(analysisId: string) {
    const handle = this.deps.client.workflow.getHandle(`site-analysis-${analysisId}`);
    try {
      if ((await handle.describe()).status.name !== "RUNNING") {
        return;
      }
      await handle.cancel();
      await handle.result();
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError) && !(error instanceof WorkflowFailedError)) {
        throw error;
      }
    }
  }
}
