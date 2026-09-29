import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import { z } from "zod";

export const BrowserScanInputSchema = z.strictObject({
  channel: z.literal("wholefoods"),
  scanId: z.string().min(1).max(200),
  sourceUrl: z.url().max(4096),
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
