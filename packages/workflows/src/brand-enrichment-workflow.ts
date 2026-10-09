import {
  BrandEnrichmentWorkflowInputSchema,
  type BrandEnrichmentWorkflowInput,
} from "@crawl-automation/v3-contracts";
import {
  CancellationScope,
  ChildWorkflowCancellationType,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  sleep,
} from "@temporalio/workflow";
import { brandEnrichmentActivities } from "./brand-enrichment-routing.js";
import { settleBrandTracks } from "./brand-enrichment-tracks.js";
import type { BrandEnrichmentActivities } from "./brand-enrichment-activities.js";

/** New workflow: explicit saga with one close path, no automatic retries and no compatibility patch. */
export async function BrandEnrichmentWorkflow(raw: BrandEnrichmentWorkflowInput): Promise<void> {
  const input = BrandEnrichmentWorkflowInputSchema.parse(raw);
  const { runId, settings } = input;
  const { plain, gated } = brandEnrichmentActivities(settings);
  let state: "completed" | "failed" | "cancelled" = "completed";
  let reason: string | undefined;
  try {
    const identity = await plain.brandIdentity({ runId });
    const family =
      identity.role === "request" && identity.hasWebsite
        ? await gated("brandFamily", { runId })
        : { children: [], products: identity.role === "sub_brand" && identity.hasWebsite };
    const tasks = [
      ...family.children.map((childRunId) => () => child(input, childRunId)),
      () => gated("brandResearch", { runId }),
      () => gated("brandApollo", { runId }),
      ...(family.products ? [() => products(input, plain)] : []),
    ];
    // Failure must not let a sibling activity keep using pages/permits after parent close.
    await settleBrandTracks(tasks);
    await plain.brandWrite({ runId });
    await gated("brandContacts", { runId });
    const review = await gated("brandReview", { runId });
    if (review.ownerRunId) {
      await child(input, review.ownerRunId);
    }
    await plain.brandOwnershipWrite({ runId });
  } catch (error) {
    state = isCancellation(error) ? "cancelled" : "failed";
    reason = String(error).slice(0, 1000);
    throw error;
  } finally {
    await CancellationScope.nonCancellable(() => closeRun({ plain, runId, state, reason }));
  }
}
async function child(input: BrandEnrichmentWorkflowInput, runId: string) {
  try {
    await executeChild(BrandEnrichmentWorkflow, {
      workflowId: `brand-enrichment-${runId}`,
      taskQueue: input.settings.taskQueue,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      retry: { maximumAttempts: 1 },
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      args: [{ ...input, runId }],
    });
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    // Its own close step retained the child's failure. Other brands continue.
  }
}
async function products(
  input: BrandEnrichmentWorkflowInput,
  activities: BrandEnrichmentActivities,
) {
  const { runId, settings } = input;
  try {
    for (let poll = 0; poll < settings.limits.productMaxPolls; poll++) {
      if ((await activities.brandProducts({ runId })).done) {
        return;
      }
      await sleep(settings.limits.productPollSeconds * 1000);
    }
    await activities.brandProductsStop({ runId });
    await activities.brandProductFailure({ runId, reason: "BRAND_ENRICHMENT.PRODUCTS_TIMEOUT" });
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    await activities.brandProductsStop({ runId });
    await activities.brandProductFailure({ runId, reason: String(error).slice(0, 1000) });
  }
}

async function closeRun(input: {
  plain: BrandEnrichmentActivities;
  runId: string;
  state: "completed" | "failed" | "cancelled";
  reason: string | undefined;
}) {
  const { plain, runId, state, reason } = input;
  try {
    if (state !== "completed") {
      await plain.brandProductsStop({ runId });
    }
  } catch (error) {
    await plain.brandClose({
      runId,
      state,
      cleanupPending: true,
      reason: `${reason ?? state}; cleanup pending: ${String(error)}`.slice(0, 1000),
    });
    throw error;
  }
  await plain.brandClose({ runId, state, ...(reason ? { reason } : {}) });
}
