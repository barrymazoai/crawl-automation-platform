import { codedFailure } from "./coded-failure.js";
import type {
  BrandListing,
  BrandScanPermit,
  GatedBrandListing,
  ListingScan,
} from "@crawl-automation/app";
import { recordRecovery } from "@crawl-automation/platform";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";

/** The listing workflow owns permits and cancellation; reattachment never repeats a paid scan. */
export class TemporalBrandListings implements GatedBrandListing {
  constructor(
    private readonly client: Client,
    private readonly settings: BrandScanPermit,
  ) {}

  async read(scan: ListingScan, signal: AbortSignal): Promise<BrandListing> {
    signal.throwIfAborted();
    const handle = await this.start(scan);
    const cancel = () =>
      void handle.cancel().catch((error: unknown) => {
        recordRecovery(error, { runId: scan.scanId, operation: "brandListing.cancel" });
      });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
    try {
      return (await handle.result()) as BrandListing;
    } catch (error) {
      // Temporal wraps Activity failures twice. Preserve their registered code for the scan's Review.
      throw codedFailure(error);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private async start(scan: ListingScan) {
    const workflowId = `brand-listing-${scan.scanId}`;
    const { taskQueue, resourceQueue, resourceId, maxWaitSeconds, gapAfterSeconds } = this.settings;
    const { sourceId, channel, url, brandName } = scan.source;
    try {
      return await this.client.workflow.start("BrandListingWorkflow", {
        workflowId,
        taskQueue,
        args: [
          {
            scanId: scan.scanId,
            source: { sourceId, channel, url, ...(brandName === undefined ? {} : { brandName }) },
            gapAfterSeconds,
            ...(this.settings.cooldownSeconds === undefined
              ? {}
              : { cooldownSeconds: this.settings.cooldownSeconds }),
            resources: {
              queue: resourceQueue,
              maxWaitSeconds,
              activities: { readBrandListing: [{ resourceId, units: 1 }] },
            },
          },
        ],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        throw error;
      }
      return this.client.workflow.getHandle(workflowId);
    }
  }
}
