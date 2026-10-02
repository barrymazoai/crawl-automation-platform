import { proxyActivities } from "@temporalio/workflow";
import {
  browserTaskQueue,
  BrowserResourceIdSchema,
} from "@crawl-automation/platform/browser-routing";
import { z } from "zod";

export const BrowserStopInputSchema = z.strictObject({
  owner: z.strictObject({
    permitId: z.string().min(1).max(200),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
  }),
  resourceId: BrowserResourceIdSchema,
});

/** Exact resource queue (R72); no retries or new permits for stop verification. */
export async function VerifyBrowserStopWorkflow(raw: unknown): Promise<void> {
  const input = BrowserStopInputSchema.parse(raw);
  const activities = proxyActivities<{ verifyBrowserStop(request: typeof input): Promise<void> }>({
    taskQueue: browserTaskQueue(input.resourceId),
    startToCloseTimeout: "2 minutes",
    scheduleToCloseTimeout: "3 minutes",
    retry: { maximumAttempts: 1 },
  });
  await activities.verifyBrowserStop(input);
}
