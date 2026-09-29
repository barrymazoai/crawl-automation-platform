import type {
  CaptureRequest,
  ListingSighting,
  ProductCapture,
  UnlistedReason,
} from "@crawl-automation/channels-core";
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
    },
  ) {}

  async capture(
    request: CaptureRequest,
    signal: AbortSignal,
  ): Promise<Exclude<Captured, Sighted> | SightedProduct> {
    const captured = await this.deps.capture.capture(request, signal);
    if (!isSighted(captured)) {
      return captured as Exclude<Captured, Sighted>;
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
}

function isSighted(captured: { status: string }): captured is Sighted {
  return captured.status === "sighted";
}
