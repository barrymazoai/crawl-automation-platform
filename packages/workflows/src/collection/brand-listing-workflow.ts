import {
  CancellationScope,
  isCancellation,
  patched,
  proxyActivities,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import { resourceGate } from "../resources/resource-gate.js";
import { BrandListingInputSchema, type BrandListingRequest } from "./brand-listing-model.js";

/** New workflow type: existing CollectionWorkflow and browser histories keep their commands. */
export async function BrandListingWorkflow(raw: unknown): Promise<unknown> {
  const { resources, gapAfterSeconds, ...request } = BrandListingInputSchema.parse(raw);
  const gap = patched("brand-listing-gap-v1") ? gapAfterSeconds : 0;
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
    return readWithGap(() => activities.readBrandListing(request), binding ? gap : 0);
  });
}

/** Remain inside the gate for every outcome; cancellation bypasses or interrupts the durable timer. */
async function readWithGap(read: () => Promise<unknown>, gapAfterSeconds: number) {
  let cancelled = false;
  try {
    return await read();
  } catch (error) {
    cancelled = isCancellation(error);
    throw error;
  } finally {
    if (gapAfterSeconds > 0 && !cancelled && !CancellationScope.current().consideredCancelled) {
      await sleep(gapAfterSeconds * 1000);
    }
  }
}
