import {
  PostgresHtmlCaptureRecords,
  PostgresListingStates,
  PostgresProductHistory,
} from "@crawl-automation/adapters";
import { listingIdentityResolver, MetricsHistory, recordSighting } from "@crawl-automation/app";
import {
  HttpCapture,
  type PageFetcher,
  type CapturedPage,
  type ChannelRegistry,
} from "@crawl-automation/channels-core";
import { errorCodeOf, type Database, type Logger } from "@crawl-automation/platform";

/**
 * What the pipeline's capture step records besides the capture itself, for every channel and machine: an unlisted
 * sighting (with its reason) instead of a Review, and for every captured page a live sighting and one
 * metrics-history point.
 */
export function captureRecords(parts: {
  database: Database;
  log: Logger;
  registry: ChannelRegistry;
}) {
  const listingStates = new PostgresListingStates(parts.database);
  return {
    listings: { record: (raw: unknown) => recordSighting(listingStates, raw) },
    history: new MetricsHistory(
      new PostgresProductHistory(parts.database),
      listingIdentityResolver(parts.registry),
    ),
    onHistoryPending(error: unknown, page: CapturedPage) {
      const code = errorCodeOf(error) ?? "HISTORY.STORAGE_UNAVAILABLE";
      const { channel, listingId, variantId, archive } = page;
      const where = { event: "HISTORY_PENDING", code, channel, listingId, variantId };
      parts.log.warn({ ...where, archiveKey: archive.objectKey }, "metrics point not stored yet");
    },
    onListingPending(error: unknown, page: CapturedPage) {
      const { channel, listingId, variantId, archive } = page;
      const where = {
        event: "LISTING_PENDING",
        code: errorCodeOf(error),
        channel,
        listingId,
        variantId,
      };
      parts.log.warn(
        { ...where, archiveKey: archive.objectKey, err: error },
        "live sighting not stored yet",
      );
    },
  };
}

/** HTTP capture admission shared by every channel, using the same database on every worker. */
export function recordedHttpCapture(pages: PageFetcher, database: Database): HttpCapture {
  return new HttpCapture(pages, new PostgresHtmlCaptureRecords(database));
}
