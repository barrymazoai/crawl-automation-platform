import { recordRecovery } from "@crawl-automation/platform";
import type {
  CapturedPage,
  CaptureRequest,
  DiscoveredVariant,
  ListingSighting,
  ProductCapture,
  UnlistedReason,
} from "@crawl-automation/channels-core";
import type { CaptureRun } from "../history/capture-history.js";
import type { ListingObservation } from "../listings/listing-model.js";
import { liveSighting, productRunSource } from "./live-sighting.js";
import {
  removedVariantSightings,
  type KnownVariants,
  type OfferedVariants,
} from "./removed-variants.js";

/** The listing a revisit found unlisted (and why), as the pipeline returns it instead of a Review. */
export interface SightedProduct {
  status: "listing";
  state: "unlisted";
  reason: UnlistedReason;
  operationId: string;
  observationId: string;
  listingId: string;
  variantId: string | null;
  causeCode: string;
  /** DTC browser capture may name the new address reached by a moved product. */
  movedTo?: { url: string; listingId: string; variantId: null };
}

type Sighted = {
  status: "sighted";
  listingId: string;
  variantId: string | null;
  sighting: ListingSighting;
  movedTo?: { url: string; listingId: string; variantId: null };
};

/**
 * The pipeline's capture step, for any capture (ScraperAPI pages with a formula plan, or browser pages): capture the
 * product page, and when the revisit shows the listing is unlisted, record that sighting with its reason (a fact for
 * the product database, not a failure) and end the product there. A page that was captured and read records a live
 * sighting (plan L2: every sighting is reported) and its metrics point.
 */
export class PipelineCapture<
  Captured extends { status: string } = Awaited<ReturnType<ProductCapture["capture"]>>,
> {
  constructor(
    private readonly deps: {
      capture: {
        capture(request: CaptureRequest, signal: AbortSignal): Promise<Captured | Sighted>;
      };
      listings: { record(raw: unknown): Promise<ListingObservation> };
      /** The metrics history; every captured page adds one point. */
      history?: { record(page: CapturedPage, run: CaptureRun): Promise<unknown> };
      /** Told when a metrics point could not be stored (the capture itself still counts). */
      onHistoryPending?(error: unknown, page: CapturedPage): void;
      /** Told when a live sighting could not be stored (the capture itself still counts). */
      onListingPending?(error: unknown, page: CapturedPage): void;
      /** Shared pages that list their variants: a variant offered before and gone now is recorded unlisted. */
      variants?: KnownVariants;
    },
  ) {}

  async capture(
    request: CaptureRequest,
    signal: AbortSignal,
  ): Promise<WithoutPage<Exclude<Captured, Sighted>> | SightedProduct> {
    const captured = await this.deps.capture.capture(request, signal);
    if (!isSighted(captured)) {
      return this.withRecords(request, captured as Exclude<Captured, Sighted>);
    }
    const { sighting, listingId, variantId, movedTo } = captured;
    const observation = await this.deps.listings.record({
      channel: request.channel,
      listingId,
      variantId,
      brandId: request.brandId,
      runId: request.runId,
      state: sighting.state,
      reason: sighting.reason,
      evidence: {
        probe: "direct-revisit",
        causeCode: sighting.causeCode,
        httpStatus: sighting.httpStatus,
        observedExternalId: sighting.observedListingId,
        finalUrl: sighting.finalUrl,
        artifactKey: sighting.archiveKey,
      },
      source: productRunSource(request),
      capturedAt: new Date().toISOString(),
    });
    return {
      status: "listing",
      state: sighting.state,
      reason: sighting.reason,
      operationId: request.operationId,
      observationId: observation.observationId,
      listingId,
      variantId,
      causeCode: sighting.causeCode,
      ...(movedTo ? { movedTo } : {}),
    };
  }

  /**
   * Records the page's live sighting and metrics point, then hands the workflow the capture without the page (its
   * payload stays as before). As in the earlier history projection, a record that fails never turns a captured
   * product into a Review: the original page stays archived, so both can be recorded again from it.
   */
  private async withRecords<Result>(
    request: CaptureRequest,
    captured: Result,
  ): Promise<WithoutPage<Result>> {
    const { page, variantPages, ...rest } = captured as Result & {
      page?: CapturedPage;
      variantPages?: { operationId: string; page: CapturedPage }[];
      discovered?: DiscoveredVariant[];
    };
    if (page) {
      await this.recordLive(request, page);
      await this.recordMetrics(request, page);
      await this.recordRemoved(request, { page, variantPages, discovered: rest.discovered });
    }
    for (const variant of variantPages ?? []) {
      const member = { ...request, operationId: variant.operationId, url: variant.page.url };
      await this.recordLive(member, variant.page);
      await this.recordMetrics(member, variant.page);
    }
    return rest as WithoutPage<Result>;
  }

  private async recordLive(request: CaptureRequest, page: CapturedPage): Promise<void> {
    try {
      await this.deps.listings.record(liveSighting(request, page));
    } catch (error) {
      recordRecovery(error, { operation: "pipeline.listing" });
      this.deps.onListingPending?.(error, page);
    }
  }

  private async recordRemoved(request: CaptureRequest, offered: OfferedVariants): Promise<void> {
    if (!this.deps.variants) {
      return;
    }
    try {
      for (const sighting of await removedVariantSightings(this.deps.variants, request, offered)) {
        await this.deps.listings.record(sighting);
      }
    } catch (error) {
      recordRecovery(error, { operation: "pipeline.removed-variants" });
      this.deps.onListingPending?.(error, offered.page);
    }
  }

  private async recordMetrics(request: CaptureRequest, page: CapturedPage): Promise<void> {
    if (!this.deps.history) {
      return;
    }
    const { runId, operationId, brandId, sourceId } = request;
    try {
      await this.deps.history.record(page, { runId, operationId, brandId, sourceId });
    } catch (error) {
      recordRecovery(error, { operation: "pipeline.history" });
      this.deps.onHistoryPending?.(error, page);
    }
  }
}

type WithoutPage<Result> = Omit<Result, "page" | "variantPages">;

function isSighted(captured: { status: string }): captured is Sighted {
  return captured.status === "sighted";
}
