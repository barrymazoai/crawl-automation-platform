import { defineErrors } from "@crawl-automation/platform";

/** Errors raised by the application services. */
export const appErrors = defineErrors({
  "EVIDENCE.NOT_FOUND": { category: "VALIDATION", message: "Archived HTML capture not found." },
  "EVIDENCE.READ_NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "This API has no storage settings, so it cannot read archived HTML.",
  },
  "EVIDENCE.NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "Test capture needs evidence.testPrefix, evidence.capture and storage settings.",
  },
  "EVIDENCE.BROWSER_CAPTURE_UNSUPPORTED": {
    category: "VALIDATION",
    message: "Browser evidence capture (Whole Foods and DTC) must use the browser worker later.",
  },
  "EVIDENCE.SINGLE_REQUEST_UNAVAILABLE": {
    category: "RUNTIME",
    message: "The capture client cannot guarantee one paid request, including redirect hops.",
  },
  "EVIDENCE.ARCHIVE_CONFLICT": {
    category: "ARTIFACT",
    message: "The test evidence key already exists; it was not overwritten or fetched again.",
  },
  "EVIDENCE.ARCHIVE_UNVERIFIED": {
    category: "ARTIFACT",
    message: "The test evidence could not be read back with its original size and SHA-256.",
  },
  "RUN.NOT_FOUND": { category: "VALIDATION", message: "Run not found." },
  "RUN.SOURCE_NOT_FOUND": { category: "VALIDATION", message: "Brand source not found." },
  "RUN.CHANNEL_UNSUPPORTED": {
    category: "VALIDATION",
    message: "Product runs are not set up for this channel yet.",
  },
  "RUN.SOURCE_DISABLED": { category: "VALIDATION", message: "Enable the source before a run." },
  "RUN.SOURCE_BUSY": { category: "VALIDATION", message: "This source already has an active run." },
  "RUN.SCAN_MISSING": {
    category: "RUNTIME",
    message: "A brand run has no brand scan; it was accepted without one.",
  },
  "RUN.REVISION_CONFLICT": { category: "VALIDATION", message: "Source changed; reload it first." },
  "RUN.STILL_RUNNING": {
    category: "VALIDATION",
    message: "The run still has running workflows; cancel it first.",
  },
  "RUN.STOP_NOT_PROVEN": {
    category: "VALIDATION",
    message:
      "A workflow of this run holds a permit and has not provably stopped (an Activity is pending or it closed under 5 minutes ago).",
  },
  "REQUEST.ID_CONFLICT": {
    category: "VALIDATION",
    message: "This request ID was already used for a different request.",
  },
  "BRAND.NOT_FOUND": { category: "VALIDATION", message: "Brand not found." },
  "BRAND.SOURCE_NOT_FOUND": { category: "VALIDATION", message: "Source not found for this brand." },
  "BRAND.REVISION_CONFLICT": {
    category: "VALIDATION",
    message: "It changed meanwhile; reload it first.",
  },
  "BRAND.DUPLICATE": {
    category: "VALIDATION",
    message: "A brand or source like this already exists.",
  },
  "PIPELINE.PLAN_UNVERIFIED": {
    category: "ARTIFACT",
    message: "The formula plan for this product is missing or no longer matches its evidence.",
  },
  "PIPELINE.LABEL_SETTINGS_MISSING": {
    category: "RUNTIME",
    message: "This worker has no settings for the shared Label workflow (its queues).",
  },
  "PIPELINE.REVIEW_UNVERIFIED": {
    category: "ARTIFACT",
    message: "The label product's Review could not be read back from the ledger.",
  },
  "PIPELINE.EXECUTION_CONFLICT": {
    category: "IDENTITY",
    message: "This product is already linked to a different workflow.",
  },
  "REVIEW.NOT_FOUND": { category: "VALIDATION", message: "Review not found." },
  "REVIEW.EVIDENCE_NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "This API has no storage settings, so it cannot read Review evidence.",
  },
  "QUEUE.IMPORT_CONFLICT": {
    category: "VALIDATION",
    message: "A product in this list is already queued with different details.",
  },
  "QUEUE.NOT_CONFIGURED": {
    category: "SCHEDULER",
    message: "The queue repository does not support the requested operation.",
  },
  "QUEUE.CLEANUP_PENDING": {
    category: "VALIDATION",
    message: "A forced stop is still settling running products; resume once they have ended.",
  },
  "QUEUE.REQUEUE_NOT_SETTLED": {
    category: "VALIDATION",
    message: "Only completed or Review products can be queued again.",
  },
  "QUEUE.SOURCE_CHANNEL_MISMATCH": {
    category: "VALIDATION",
    message: "A product's brand source does not exist or belongs to another channel.",
  },
  "QUEUE.RUN_FAILED": { category: "SCHEDULER", message: "The product run's workflow failed." },
  "QUEUE.RUN_CANCELLED": { category: "SCHEDULER", message: "The product run was cancelled." },
  "QUEUE.RUN_TERMINATED": { category: "SCHEDULER", message: "The product run was terminated." },
  "QUEUE.RUN_TIMED_OUT": { category: "SCHEDULER", message: "The product run timed out." },
  "QUEUE.RUN_REVIEW": { category: "PROCESSING", message: "The product ended in a Review." },
  "QUEUE.OUTCOME_UNRECOGNIZED": {
    category: "SCHEDULER",
    message: "The product run completed with a result the queue does not recognize.",
  },
  "QUEUE.STOPPED_BEFORE_START": {
    category: "SCHEDULER",
    message: "The queue was stopped before this product's run started.",
  },
  "LISTING.OBSERVATION_CONFLICT": {
    category: "ARTIFACT",
    message: "A different listing observation is already recorded under this key.",
  },
  "LISTING.REASON_EVIDENCE_MISSING": {
    category: "VALIDATION",
    message: "An unlisted sighting must carry its reason and that reason's evidence.",
  },
  "LISTING.DELIVERY_NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "Sending listing states to the product database is not enabled.",
  },
  "PERMIT.VERIFICATION_NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "Permit stop verification is not configured.",
  },
  "PERMIT.NOT_FOUND": { category: "VALIDATION", message: "Permit not found or already released." },
  "PERMIT.OWNER_RUNNING": {
    category: "VALIDATION",
    message: "The workflow holding this permit is still running.",
  },
  "PERMIT.STOP_NOT_PROVEN": {
    category: "VALIDATION",
    message:
      "The permit requires a closed exact owner, no pending Activities and stop proof for every executor.",
  },
  "DELIVERY.CHANNEL_NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "No workflow target is configured for this channel.",
  },
  "DELIVERY.CLUSTER_MISMATCH": {
    category: "RUNTIME",
    message: "A delivery target points at a different Temporal cluster.",
  },
  "BRAND_SCAN.NO_SOURCES": {
    category: "VALIDATION",
    message: "The channel has no enabled brand sources to scan.",
  },
  "BRAND_SCAN.SOURCE_DISABLED": {
    category: "VALIDATION",
    message: "Only an enabled brand source can be scanned.",
  },
  "BRAND_SCAN.CHANNEL_UNSUPPORTED": {
    category: "VALIDATION",
    message: "This channel has no brand-scan reader.",
  },
  "BRAND_SCAN.BROWSER_NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "This channel is scanned in a browser, and no browser is configured for it here.",
  },
  "PRODUCT.NOT_FOUND": { category: "VALIDATION", message: "Collected product not found." },
  "SCAN.NOT_FOUND": { category: "VALIDATION", message: "Brand scan not found." },
  "BRAND_SCAN.NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "Brand scans need their settings (R2 and ScraperAPI) in this process's config.",
  },
});
