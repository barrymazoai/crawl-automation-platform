import { ChannelIdSchema } from "@crawl-automation/v3-contracts";
import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import { z } from "zod";

export const BrowserScanInputSchema = z.strictObject({
  channel: ChannelIdSchema,
  /** Browser-only workflow; old histories omit this field. No default changes their activity payload. */
  capture: z.literal("browser").optional(),
  scanId: z.string().min(1).max(200),
  sourceUrl: z.url().max(4096),
  /** Database brand source, distinct from the channel's evidence key; old histories omit it. */
  sourceId: z.uuid().optional(),
});
export type BrowserScanInput = z.infer<typeof BrowserScanInputSchema>;

/**
 * One brand listing read in the browser, on the browser machine's task queue: the API process never drives Ego, it
 * starts this workflow and waits for its result. One attempt; a failure is the scan's Review.
 */
export async function BrowserScanWorkflow(raw: unknown): Promise<unknown> {
  const input = BrowserScanInputSchema.parse(raw);
  const browser = proxyActivities<{
    scanBrandInBrowser(input: BrowserScanInput): Promise<unknown>;
  }>({
    taskQueue: workflowInfo().taskQueue,
    startToCloseTimeout: "30 minutes",
    scheduleToCloseTimeout: "60 minutes",
    retry: { maximumAttempts: 1 },
  });
  return browser.scanBrandInBrowser(input);
}
