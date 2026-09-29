import type { CapturedPage } from "@crawl-automation/channels-core";
import { canonicalHash, timestamp } from "./canonical.js";
import { commerceMetrics } from "./commerce-metrics.js";
import { historyErrors } from "./history-errors.js";
import { identifyListing } from "./listing-identity.js";
import type { HistoryEntry } from "./ports.js";

/** The product run a capture belongs to. */
export interface CaptureRun {
  runId: string;
  operationId: string;
  brandId: string;
  sourceId: string;
}

const CODEC = "v3-capture-history/1";

/**
 * The history entry of one capture: the capture record (`v3-capture-history/1`, dataset `v3:<channel>`, one per
 * product operation), its listing and its one metrics point — the same shape and IDs the earlier history
 * projection wrote, so the product service's history export reads both alike.
 */
export function captureHistoryEntry(page: CapturedPage, run: CaptureRun): HistoryEntry {
  const dataset = `v3:${page.channel}`;
  const observationId = run.operationId;
  const metrics = commerceMetrics(page.commerce);
  const evidence = [{ objectKey: page.archive.objectKey, sha256: page.archive.sha256 }];
  const raw = {
    codec: CODEC,
    dataset,
    observationId,
    owner: { ...run },
    capturedAt: timestamp(page.capturedAt),
    listing: { channel: page.channel, url: page.url, externalId: page.externalId },
    metrics,
    evidence,
    capture: { runId: run.runId, operationId: run.operationId, variantId: page.variantId },
  };
  const listing = identifyListing({ ...page, sourceKey: observationId, dataset });
  if (listing.basis === "unresolved") {
    throw historyErrors.create("HISTORY.CAPTURE_IDENTITY_UNRESOLVED", {
      details: { channel: page.channel, url: page.url },
    });
  }
  const point = {
    listingId: listing.id,
    kind: "metrics" as const,
    observedAt: raw.capturedAt,
    record: { ...metrics, source: dataset, observationId, evidence },
  };
  return {
    id: canonicalHash([CODEC, dataset, observationId]),
    dataset,
    sourceKey: observationId,
    bodyHash: canonicalHash(raw),
    raw,
    listings: [listing],
    observations: [{ id: canonicalHash(point), ...point }],
    issues: raw.capturedAt ? [] : ["HISTORY.METRIC_TIME_UNKNOWN"],
  };
}
