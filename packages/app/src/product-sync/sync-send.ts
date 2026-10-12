import { deliverLabel } from "../product-delivery/label-delivery.js";
import type { ProductObservationWriter } from "../product-delivery/ports.js";
import {
  acceptedItems,
  itemProblems,
  verificationExpectation,
} from "../product-delivery/verification.js";
import type { DeliveryRun } from "../product-delivery/wire.js";
import type { ProductVerifyBatchAnswer } from "@crawl-automation/v3-contracts";
import { reasonText, sentChange, type PlannedSync, type SyncTally } from "./sync-model.js";

/** Stable across runs: Supply Smart's snapshot replay key includes the source (review 2026-10-12). */
const SOURCE = "crawl-automation:marketplace-sync";
const NEEDS_REVIEW = "needs_review";
const RUN_OPEN = "run_not_completed";

interface Batch {
  writer: ProductObservationWriter;
  runId: string;
  planned: [PlannedSync, ...PlannedSync[]];
}

/**
 * One partial ingest run: items, then each accepted item's label, a per-item read-back verification, and the run's
 * close (partial: Supply Smart never delists from it).
 */
export async function sendBatch(batch: Batch, tally: SyncTally, signal: AbortSignal) {
  const accepted = await ingestWithLabels(batch, tally, signal);
  if (accepted.length) {
    await verifyAccepted({ ...batch, accepted }, tally, signal);
  }
  const closed = await batch.writer.complete({ runId: batch.runId, status: "completed" }, signal);
  tally.result.runCompleted =
    closed.found && closed.scope === "partial" && closed.problems.length === 0;
}

function partialRun(batch: Batch): DeliveryRun {
  const times = batch.planned.map((entry) => entry.item.capturedAt);
  const [startedAt] = times.sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    runId: batch.runId,
    channel: batch.planned[0].product.channel,
    scope: "partial",
    startedAt: startedAt ?? batch.planned[0].item.capturedAt,
    source: SOURCE,
  };
}

function fail(tally: SyncTally, at: { entry: PlannedSync; runId: string; reason: string }) {
  const { entry, runId, reason } = at;
  tally.result.failed.push({ externalId: entry.item.externalId ?? entry.key.listingId, reason });
  tally.changes.push({
    ...sentChange(entry, runId),
    status: "failed",
    error: { reason: reasonText(reason) },
  });
}

async function ingestWithLabels(batch: Batch, tally: SyncTally, signal: AbortSignal) {
  const { writer, runId, planned } = batch;
  const answer = await writer.ingest(
    { run: partialRun(batch), items: planned.map((entry) => entry.item) },
    signal,
  );
  const accepted: PlannedSync[] = [];
  for (const { product: entry, reason } of acceptedItems(answer, { runId, products: planned })) {
    const refused =
      reason && reason !== NEEDS_REVIEW ? reason : await labelOf(writer, entry, signal);
    if (refused) {
      fail(tally, { entry, runId, reason: refused });
    } else {
      accepted.push(entry);
    }
  }
  return accepted;
}

/** Whole Foods without a same-ASIN Amazon collection has no label: the observation goes without one. */
function labelOf(writer: ProductObservationWriter, entry: PlannedSync, signal: AbortSignal) {
  return entry.label
    ? deliverLabel({ writer, product: { item: entry.item, label: entry.label } }, signal)
    : Promise.resolve(null);
}

/**
 * Each product is judged on its own read-back: one item in Supply Smart's identity review lowers the batch's
 * verified count but must not fail its clean siblings (review 2026-10-12). A run-level mismatch fails all.
 */
async function verifyAccepted(
  batch: Batch & { accepted: PlannedSync[] },
  tally: SyncTally,
  signal: AbortSignal,
) {
  const { writer, runId, accepted } = batch;
  const answer = await writer.verify(
    {
      runId,
      clientRefs: accepted.map(({ item }) => item.clientRef),
      expect: accepted.map(verificationExpectation),
    },
    signal,
  );
  const runProblems = [
    ...(answer.runId === runId && answer.found ? [] : ["PRODUCT_DELIVERY.VERIFY_FAILED"]),
    ...answer.problems.filter((problem) => problem !== RUN_OPEN),
  ];
  for (const entry of accepted) {
    const read = answer.items.find((item) => item.clientRef === entry.item.clientRef);
    const problems = [...runProblems, ...itemProblems(read)];
    const real = [...new Set(problems.filter((problem) => problem !== NEEDS_REVIEW))];
    if (real.length) {
      fail(tally, { entry, runId, reason: real.join("; ") });
    } else {
      recordVerified(tally, { entry, runId, review: problems.includes(NEEDS_REVIEW), read });
    }
  }
}

/** Stored in Supply Smart; "needs_review" is Supply Smart's own identity queue, not a reason to resend. */
function recordVerified(
  tally: SyncTally,
  at: {
    entry: PlannedSync;
    runId: string;
    review: boolean;
    read: ProductVerifyBatchAnswer["items"][number] | undefined;
  },
) {
  const { entry, runId, review, read } = at;
  tally.result.verified += 1;
  tally.result.needsReview += review ? 1 : 0;
  tally.changes.push({
    ...sentChange(entry, runId),
    status: "verified",
    supplySmartProductId: read?.product?.id ?? null,
    supplySmartListingId: read?.listing?.id ?? null,
    error: review ? { supplySmart: NEEDS_REVIEW } : null,
  });
}
