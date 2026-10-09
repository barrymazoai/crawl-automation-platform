import type { BrandEnrichmentWorkflowSettings } from "@crawl-automation/v3-contracts";
import { ActivityCancellationType, proxyActivities } from "@temporalio/workflow";
import { resourceGate } from "./resources/resource-gate.js";
import { browserRoute } from "./resources/browser-route.js";
import type { BrandEnrichmentActivities } from "./brand-enrichment-activities.js";

const options = {
  startToCloseTimeout: "60 minutes",
  scheduleToCloseTimeout: "120 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
} as const;
type GatedName = "brandFamily" | "brandResearch" | "brandApollo" | "brandContacts" | "brandReview";

/** One gate sequence per workflow, including both browser routes, prevents duplicate permit IDs. */
export function brandEnrichmentActivities(settings: BrandEnrichmentWorkflowSettings) {
  const routes = Object.fromEntries(
    ["brandFamily", "brandResearch"].map((activity) => [
      activity,
      browserRoute({
        activity,
        resources: settings.resources,
        queue: settings.queues.browser,
        required: true,
      }),
    ]),
  );
  const activities = { ...settings.resources.activities };
  for (const [name, route] of Object.entries(routes)) {
    const needs = route.resources?.activities[name];
    if (needs) {
      activities[name] = needs;
    }
  }
  const gate = resourceGate({ ...settings.resources, activities });
  const plain = proxyActivities<BrandEnrichmentActivities>({
    ...options,
    taskQueue: settings.queues.activities,
  });
  function gated<Name extends GatedName>(
    name: Name,
    input: { runId: string },
  ): ReturnType<BrandEnrichmentActivities[Name]> {
    const taskQueue = routes[name]?.queue ?? settings.queues.model;
    return gate(name, (binding) => {
      const client: BrandEnrichmentActivities = proxyActivities<BrandEnrichmentActivities>({
        ...options,
        taskQueue,
        ...binding,
      });
      return client[name](input);
    }) as ReturnType<BrandEnrichmentActivities[Name]>;
  }
  return { plain, gated };
}
