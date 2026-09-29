import type {
  CapturedPage,
  CaptureRequest,
  ListingSighting,
  ProductCapture,
  UnlistedReason,
} from "@crawl-automation/channels-core";
import type { CaptureRun } from "../history/capture-history.js";
import type { ListingObservation } from "../listings/listing-model.js";

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
}

type Sighted = {
  status: "sighted";
  listingId: string;
  variantId: string | null;
  sighting: ListingSighting;
};

/**
 * The pipeline's capture step, for any capture (ScraperAPI pages with a formula plan, or browser pages): capture the
 * product page, and when the revisit shows the listing is unlisted, record that sighting with its reason (a fact for
 * the product database, not a failure) and end the product there.
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
    },
  ) {}

  async capture(
    request: CaptureRequest,
    signal: AbortSignal,
  ): Promise<WithoutPage<Exclude<Captured, Sighted>> | SightedProduct> {
    const captured = await this.deps.capture.capture(request, signal);
    if (!isSighted(captured)) {
      return this.withMetrics(request, captured as Exclude<Captured, Sighted>);
    }
    const { sighting, listingId, variantId } = captured;
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
      source: `crawler-v3:product-run:${request.operationId}`,
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
    };
  }

  /**
   * Records the page's metrics point, then hands the workflow the capture without the page (its payload stays as
   * before). As in the earlier history projection, a history write that fails never turns a captured product into
   * a Review: the original page stays archived, so the point can be recorded again from it.
   */
  private async withMetrics<Result>(
    request: CaptureRequest,
    captured: Result,
  ): Promise<WithoutPage<Result>> {
    const { page, ...rest } = captured as Result & { page?: CapturedPage };
    if (page && this.deps.history) {
      const run = {
        runId: request.runId,
        operationId: request.operationId,
        brandId: request.brandId,
        sourceId: request.sourceId,
      };
      try {
        await this.deps.history.record(page, run);
      } catch (error) {
        this.deps.onHistoryPending?.(error, page);
      }
    }
    return rest as WithoutPage<Result>;
  }
}

type WithoutPage<Result> = Omit<Result, "page">;

function isSighted(captured: { status: string }): captured is Sighted {
  return captured.status === "sighted";
}
