import type { ReviewRecord } from "@crawl-automation/v3-contracts";

/**
 * A read-only view of what a Review's inspection target would need. Nothing is repaired, retried or restarted; no
 * inspection target is wired today, so a Review that names one is reported as not configured.
 */
export function inspectReview(record: ReviewRecord, observedAt: Date = new Date()) {
  const base = {
    reviewId: record.reviewId,
    observedAt: observedAt.toISOString(),
    mutatesState: false as const,
    automaticRetry: false as const,
  };
  const status = record.inspection.kind === "none" ? "NOT_APPLICABLE" : "NOT_CONFIGURED";
  return { ...base, status };
}
