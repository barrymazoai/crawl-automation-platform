import type {
  BrandEnrichmentWorkflowInput,
  BrandProductsAttempt,
} from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentActivities } from "./brand-enrichment-activities.js";
import { CancellationScope, isCancellation, sleep } from "@temporalio/workflow";

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

/** Shared products loop; omission of attempt preserves historical activity payloads. */
export async function runBrandProducts(
  input: BrandEnrichmentWorkflowInput & BrandProductsAttempt,
  activities: BrandEnrichmentActivities,
) {
  const { runId, settings, attempt } = input;
  const target = { runId, ...(attempt === undefined ? {} : { attempt }) };
  try {
    for (let poll = 0; poll < settings.limits.productMaxPolls; poll++) {
      if ((await activities.brandProducts(target)).done) {
        return;
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
