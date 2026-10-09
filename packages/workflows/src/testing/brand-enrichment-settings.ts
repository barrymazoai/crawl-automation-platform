import { BrandEnrichmentWorkflowSettingsSchema } from "@crawl-automation/v3-contracts";

export function brandSettings(queue = "brands") {
  const needs = [{ resourceId: "mini-model-account", units: 1 }];
  return BrandEnrichmentWorkflowSettingsSchema.parse({
    taskQueue: queue,
    queues: { activities: queue, model: queue, browser: queue },
    limits: { productPollSeconds: 5, productMaxPolls: 2 },
    resources: {
      queue,
      activities: Object.fromEntries(
        ["brandFamily", "brandResearch", "brandApollo", "brandContacts", "brandReview"].map(
          (name) => [name, needs],
        ),
      ),
    },
  });
}
