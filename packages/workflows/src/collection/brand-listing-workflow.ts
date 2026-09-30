import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import { resourceGate } from "../resources/resource-gate.js";
import { BrandListingInputSchema, type BrandListingRequest } from "./brand-listing-model.js";

/** New workflow type: existing CollectionWorkflow and browser histories keep their commands. */
export async function BrandListingWorkflow(raw: unknown): Promise<unknown> {
  const { resources, ...request } = BrandListingInputSchema.parse(raw);
  return resourceGate(resources)("readBrandListing", (binding) => {
    const activities = proxyActivities<{
      readBrandListing(input: BrandListingRequest): Promise<unknown>;
    }>({
      taskQueue: workflowInfo().taskQueue,
      startToCloseTimeout: "30 minutes",
      scheduleToCloseTimeout: "60 minutes",
      retry: { maximumAttempts: 1 },
      ...binding,
    });
    return activities.readBrandListing(request);
  });
}
