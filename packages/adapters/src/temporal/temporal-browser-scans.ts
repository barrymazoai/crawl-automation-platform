import { recordRecovery } from "@crawl-automation/platform";
import type { BrandScanPermit, BrowserBrandScan } from "@crawl-automation/app";
import type { ChannelId } from "@crawl-automation/v3-contracts";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";
import { z } from "zod";
import { codedFailure } from "./coded-failure.js";

/** A browser scan's result as the browser worker returns it; its pages are checked by the scan service. */
const BrowserBrandScanSchema = z.object({
  pages: z.array(z.unknown()),
  complete: z.boolean(),
  soldHere: z.boolean(),
  archiveKeys: z.array(z.string()),
  cooldownRequested: z.boolean().optional(),
});

/**
 * Brand listings only the browser can read, scanned on the browser machine: this process starts one
 * `BrowserScanWorkflow` per scan on the browser task queue and waits for it. It never drives a browser itself.
 */
export class TemporalBrowserScans {
  constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
    private readonly permits: Partial<Record<ChannelId, BrandScanPermit>> = {},
  ) {}

  async scan(
    request: { channel: ChannelId; scanId: string; sourceUrl: string },
    signal: AbortSignal,
  ): Promise<BrowserBrandScan> {
    signal.throwIfAborted();
    const handle = await this.start(request);
    const cancel = () =>
      void handle.cancel().catch((error: unknown) => {
        recordRecovery(error, { runId: request.scanId, operation: "browserScan.cancel" });
      });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
    try {
      const result = BrowserBrandScanSchema.parse(await handle.result());
      return result as BrowserBrandScan;
    } catch (error) {
      throw codedFailure(error);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private async start(request: { channel: ChannelId; scanId: string; sourceUrl: string }) {
    const workflowId = `browser-scan-${request.scanId}`;
    try {
      return await this.client.workflow.start("BrowserScanWorkflow", {
        workflowId,
        taskQueue: this.permits[request.channel]?.taskQueue ?? this.taskQueue,
        args: [{ ...request, capture: "browser", ...this.gate(request.channel) }],
        // The same scan asked again waits for the one already running; nothing is scanned twice.
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
        ...(this.permits[request.channel] ? {} : { workflowExecutionTimeout: "90 minutes" }),
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        throw error;
      }
      // Reconnect even to a closed result; never start a replacement browser operation.
      return this.client.workflow.getHandle(workflowId);
    }
  }

  private gate(channel: ChannelId) {
    const permit = this.permits[channel];
    if (!permit) {
      return {};
    }
    return {
      gapAfterSeconds: permit.gapAfterSeconds,
      cooldownSeconds: permit.cooldownSeconds ?? 0,
      resources: {
        queue: permit.resourceQueue,
        maxWaitSeconds: permit.maxWaitSeconds,
        activities: {
          scanBrandInBrowser: [
            { resourceId: permit.resourceId, units: 1 },
            ...(permit.additionalResources ?? []),
          ],
        },
      },
    };
  }
}
