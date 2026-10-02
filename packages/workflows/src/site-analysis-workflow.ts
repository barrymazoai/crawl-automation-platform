import { SiteAnalysisSchema, ResourceGateSchema } from "@crawl-automation/v3-contracts";
import { patched, proxyActivities, workflowInfo } from "@temporalio/workflow";
import { resourceGate } from "./resources/resource-gate.js";
import { browserRoute } from "./resources/browser-route.js";

export const SiteAnalysisWorkflowInput = SiteAnalysisSchema.extend({
  resources: ResourceGateSchema,
});

/** New workflow type: a single browser activity, routed and stop-proven with the existing host gate. */
export async function SiteAnalysisWorkflow(raw: unknown): Promise<unknown> {
  const { resources, ...analysis } = SiteAnalysisWorkflowInput.parse(raw);
  patched("dtc-site-analysis-v1");
  const route = browserRoute({
    resources,
    activity: "analyzeSiteInBrowser",
    queue: workflowInfo().taskQueue,
    required: true,
  });
  return resourceGate(route.resources)("analyzeSiteInBrowser", (binding) => {
    const activity = proxyActivities<{ analyzeSiteInBrowser(input: unknown): Promise<unknown> }>({
      taskQueue: route.queue,
      startToCloseTimeout: "30 minutes",
      scheduleToCloseTimeout: "60 minutes",
      retry: { maximumAttempts: 1 },
      ...binding,
    });
    return activity.analyzeSiteInBrowser(analysis);
  });
}
