import { KNOWN_RESOURCE_KINDS, type ResourceKinds } from "@crawl-automation/channels-core";
import { browserResources } from "@crawl-automation/platform/browser-routing";
import type { ResourceGate } from "@crawl-automation/v3-contracts";
import type { z } from "zod";

/** Shared API/worker validation: the workflow receives the API's gates, not the worker's local copy. */
export function validateBrandEnrichmentSettings(
  config: {
    brandEnrichment?: { resources: ResourceGate } | undefined;
    resourceKinds: ResourceKinds;
  },
  ctx: z.RefinementCtx,
) {
  if (!config.brandEnrichment) {
    return;
  }
  const kinds = { ...KNOWN_RESOURCE_KINDS, ...config.resourceKinds };
  for (const activity of [
    "brandFamily",
    "brandResearch",
    "brandApollo",
    "brandContacts",
    "brandReview",
  ]) {
    const needs = config.brandEnrichment.resources.activities[activity] ?? [];
    const actual = needs.map((need) => kinds[need.resourceId]);
    const browsers = browserResources(needs.map((need) => need.resourceId));
    const browser = ["brandFamily", "brandResearch"].includes(activity);
    if (
      !actual.includes("model") ||
      (browser ? browsers.length !== 1 : actual.includes("browser"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["brandEnrichment", "resources", "activities", activity],
        message:
          "Model permit required; browser work also needs exactly one registered browser space",
      });
    }
  }
}
