import type {
  CaptureRequest,
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

type Captured = Awaited<ReturnType<ProductCapture["capture"]>>;

/**
 * The pipeline's capture step: capture the product page, and when the revisit shows the listing is unlisted,
 * record that sighting with its reason (a fact for the product database, not a failure) and end the product there.
 */
export class PipelineCapture {
  constructor(
    private readonly deps: {
      capture: Pick<ProductCapture, "capture">;
      listings: { record(raw: unknown): Promise<ListingObservation> };
    },
  ) {}

  async capture(
    request: CaptureRequest,
    signal: AbortSignal,
  ): Promise<Exclude<Captured, { status: "sighted" }> | SightedProduct> {
    const captured = await this.deps.capture.capture(request, signal);
    if (captured.status !== "sighted") {
      return captured;
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
