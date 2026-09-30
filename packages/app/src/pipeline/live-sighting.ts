import { listingErrors } from "@crawl-automation/platform";
import type { CaptureRequest, CapturedPage } from "@crawl-automation/channels-core";
import type { ListingSightingInput } from "../listings/listing-model.js";

/** The cause a live sighting records: the product run read the listing's own page. */
export const LIVE_CAUSE_CODE = listingErrors.code("LISTING.LIVE");

/** Names what saw a sighting: the product run's operation. A live and an unlisted sighting never share one. */
export function productRunSource(request: Pick<CaptureRequest, "operationId">): string {
  return `crawler-v3:product-run:${request.operationId}`;
}

/**
 * A listing whose own page was captured and read is live (plan L2: the crawler reports every sighting, the product
 * database decides delisting). The archived page is its evidence.
 */
export function liveSighting(request: CaptureRequest, page: CapturedPage): ListingSightingInput {
  return {
    channel: page.channel,
    listingId: page.listingId,
    variantId: page.variantId,
    brandId: request.brandId,
    runId: request.runId,
    state: "live",
    reason: null,
    evidence: {
      probe: "direct-revisit",
      causeCode: LIVE_CAUSE_CODE,
      httpStatus: null,
      observedExternalId: null,
      finalUrl: page.url,
      artifactKey: page.archive.objectKey,
    },
    source: productRunSource(request),
    capturedAt: page.capturedAt,
  };
}
