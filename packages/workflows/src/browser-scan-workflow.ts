import { ChannelIdSchema, ResourceGateSchema } from "@crawl-automation/v3-contracts";
import { patched, proxyActivities, workflowInfo } from "@temporalio/workflow";
import { z } from "zod";
import { resourceGate, type ResourceActivityBinding } from "./resources/resource-gate.js";
import { readWithScanGap } from "./collection/scan-gap.js";
import { browserRoute } from "./resources/browser-route.js";

export const BrowserScanInputSchema = z.strictObject({
  channel: ChannelIdSchema,
  /** Browser-only workflow; old histories omit this field. No default changes their activity payload. */
  capture: z.literal("browser").optional(),
  scanId: z.string().min(1).max(200),
  sourceUrl: z.url().max(4096),
  /** Database brand source, distinct from the channel's evidence key; old histories omit it. */
  sourceId: z.uuid().optional(),
  resources: ResourceGateSchema.optional(),
  gapAfterSeconds: z.number().int().nonnegative().optional(),
  cooldownSeconds: z.number().int().nonnegative().optional(),
});
export type BrowserScanInput = z.infer<typeof BrowserScanInputSchema>;

/**
 * One brand listing read in the browser, on the browser machine's task queue: the API process never drives Ego, it
 * starts this workflow and waits for its result. One attempt; a failure is the scan's Review.
 */
export async function BrowserScanWorkflow(raw: unknown): Promise<unknown> {
  const { resources, gapAfterSeconds, cooldownSeconds, ...input } =
    BrowserScanInputSchema.parse(raw);
  if (!patched("browser-scan-permit-v1")) {
    return scan(input);
  }
  const route = browserRoute({
    resources,
    activity: "scanBrandInBrowser",
    queue: workflowInfo().taskQueue,
    required: true,
  });
  return resourceGate(route.resources)("scanBrandInBrowser", (binding) =>
    readWithScanGap(() => scan(input, binding, route.queue), {
      gapAfterSeconds: binding ? (gapAfterSeconds ?? 0) : 0,
      cooldownSeconds: binding ? (cooldownSeconds ?? 0) : 0,
    }),
  );
}

function scan(input: BrowserScanInput, binding?: ResourceActivityBinding, queue?: string) {
  const browser = proxyActivities<{
    scanBrandInBrowser(input: BrowserScanInput): Promise<unknown>;
  }>({
    taskQueue: queue ?? workflowInfo().taskQueue,
    startToCloseTimeout: "30 minutes",
    scheduleToCloseTimeout: "60 minutes",
    retry: { maximumAttempts: 1 },
    ...binding,
  });
  return browser.scanBrandInBrowser(input);
}
