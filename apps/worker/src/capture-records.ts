import { PostgresListingStates, PostgresProductHistory } from "@crawl-automation/adapters";
import { MetricsHistory, recordSighting } from "@crawl-automation/app";
import type { CapturedPage } from "@crawl-automation/channels-core";
import { errorCodeOf, type Database, type Logger } from "@crawl-automation/platform";

/**
 * What the pipeline's capture step records besides the capture itself, for every channel and machine: an unlisted
 * sighting (with its reason) instead of a Review, and for every captured page a live sighting and one
 * metrics-history point.
 */
export function captureRecords(parts: { database: Database; log: Logger }) {
  const listingStates = new PostgresListingStates(parts.database);
  return {
    listings: { record: (raw: unknown) => recordSighting(listingStates, raw) },
    history: new MetricsHistory(new PostgresProductHistory(parts.database)),
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
