import type {
  BrandEnrichmentWorkflowInput,
  BrandProductProgress,
  BrandProductsAttempt,
} from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentActivities } from "./brand-enrichment-activities.js";
import { CancellationScope, isCancellation, patched, sleep } from "@temporalio/workflow";

/** Structured concurrency: cancel siblings on failure, then await their cancellation acknowledgements. */
export async function settleBrandTracks(tracks: (() => Promise<unknown>)[]): Promise<void> {
  const scope = new CancellationScope();
  await scope.run(async () => {
    let firstFailure: { error: unknown } | undefined;
    const tasks = tracks.map((track) =>
      track().catch((error: unknown) => {
        firstFailure ??= { error };
        scope.cancel();
        throw error;
      }),
    );
    await Promise.allSettled(tasks);
    if (firstFailure) {
      throw firstFailure.error;
    }
  });
}

/**
 * The brand run's products track. Owner 2026-10-20 (bloodsugarfriendly.com): an attempt whose site analysis failed
 * or verified no brand is tried once more inside the run; operator retries continue from the next attempt.
 */
export async function brandProductsTrack(
  input: BrandEnrichmentWorkflowInput,
  activities: BrandEnrichmentActivities,
) {
  const first = await runBrandProducts(input, activities);
  if (first?.retry && patched("brand-products-auto-retry-v1")) {
    await runBrandProducts({ ...input, attempt: 2 }, activities);
  }
}

/** Shared products loop; omission of attempt preserves historical activity payloads. */
export async function runBrandProducts(
  input: BrandEnrichmentWorkflowInput & BrandProductsAttempt,
  activities: BrandEnrichmentActivities,
): Promise<BrandProductProgress | undefined> {
  const { runId, settings, attempt } = input;
  const target = { runId, ...(attempt === undefined ? {} : { attempt }) };
  try {
    for (let poll = 0; poll < settings.limits.productMaxPolls; poll++) {
      const progress = await activities.brandProducts(target);
      if (progress.done) {
        return progress;
      }
      await sleep(settings.limits.productPollSeconds * 1000);
    }
    await activities.brandProductsStop(target);
    await activities.brandProductFailure({
      ...target,
      reason: "BRAND_ENRICHMENT.PRODUCTS_TIMEOUT",
    });
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    await activities.brandProductsStop(target);
    await activities.brandProductFailure({ ...target, reason: String(error).slice(0, 1000) });
  }
}
