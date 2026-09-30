import type { BrowserBrandScan } from "@crawl-automation/app";
import type { ChannelId } from "@crawl-automation/v3-contracts";
import type { Client } from "@temporalio/client";
import { z } from "zod";

/** A browser scan's result as the browser worker returns it; its pages are checked by the scan service. */
const BrowserBrandScanSchema = z.object({
  pages: z.array(z.unknown()),
  complete: z.boolean(),
  soldHere: z.boolean(),
  archiveKeys: z.array(z.string()),
});

/**
 * Brand listings only the browser can read, scanned on the browser machine: this process starts one
 * `BrowserScanWorkflow` per scan on the browser task queue and waits for it. It never drives a browser itself.
 */
export class TemporalBrowserScans {
  constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
  ) {}

  async scan(
    request: { channel: ChannelId; scanId: string; sourceUrl: string },
    signal: AbortSignal,
  ): Promise<BrowserBrandScan> {
    const handle = await this.client.workflow.start("BrowserScanWorkflow", {
      workflowId: `browser-scan-${request.scanId}`,
      taskQueue: this.taskQueue,
      args: [{ ...request, capture: "browser" }],
      // The same scan asked again waits for the one already running; nothing is scanned twice.
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowExecutionTimeout: "90 minutes",
    });
    const cancel = () => void handle.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = BrowserBrandScanSchema.parse(await handle.result());
      return result as BrowserBrandScan;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
