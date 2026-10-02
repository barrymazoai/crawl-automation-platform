import { patched, proxyActivities, workflowInfo } from "@temporalio/workflow";
import { readWithScanGap } from "./scan-gap.js";
import { resourceGate } from "../resources/resource-gate.js";
import { BrandListingInputSchema, type BrandListingRequest } from "./brand-listing-model.js";
import { browserRoute } from "../resources/browser-route.js";

/** New workflow type: existing CollectionWorkflow and browser histories keep their commands. */
export async function BrandListingWorkflow(raw: unknown): Promise<unknown> {
  const { resources, gapAfterSeconds, cooldownSeconds, ...request } =
    BrandListingInputSchema.parse(raw);
  const gap = patched("brand-listing-gap-v1") ? gapAfterSeconds : 0;
  const cooldown = patched("brand-listing-cooldown-v1") ? cooldownSeconds : 0;
  const route = browserRoute({
    resources,
    activity: "readBrandListing",
    queue: workflowInfo().taskQueue,
    required: false,
  });
  return resourceGate(route.resources)("readBrandListing", (binding) => {
    const activities = proxyActivities<{
      readBrandListing(input: BrandListingRequest): Promise<unknown>;
    }>({
      taskQueue: route.queue,
      startToCloseTimeout: "30 minutes",
      scheduleToCloseTimeout: "60 minutes",
      retry: { maximumAttempts: 1 },
      ...binding,
    });
    return readWithScanGap(() => activities.readBrandListing(request), {
      gapAfterSeconds: binding ? gap : 0,
      cooldownSeconds: binding ? cooldown : 0,
    });
  });
}
