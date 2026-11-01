import { landingPageListing } from "@crawl-automation/platform";
import type { ChannelAdapter } from "../adapter.js";
import { channelErrors } from "../errors.js";
import { movedSighting, type ListingSighting } from "../pipeline/listing-sighting.js";
import type { ArchivedHtml, OriginalHtmlArchive } from "./original-html-archive.js";

/** A same-listing landing page is a Review; a genuine move is a listing sighting. */
export function movedPage(
  adapter: ChannelAdapter,
  archive: OriginalHtmlArchive,
  saved: ArchivedHtml,
): ListingSighting | null {
  if (!saved.finalUrl) {
    return null;
  }
  const { url, listingId, variantId } = archive.capture;
  const shown = landingPageListing(saved.finalUrl, new URL(url));
  if (shown?.toUpperCase() === listingId.toUpperCase()) {
    throw channelErrors.create("CAPTURE.LANDING_PAGE", {
      details: {
        finalUrl: saved.finalUrl,
        archiveKey: saved.source.objectKey,
        reason: `landing page /clp/${shown}`,
        evidence: { objectKey: saved.source.objectKey },
      },
    });
  }
  return movedSighting(
    adapter,
    { url, listingId, variantId },
    { finalUrl: saved.finalUrl, archiveKey: saved.source.objectKey },
  );
}
