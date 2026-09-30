import { withCause } from "@crawl-automation/platform";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";
import { activityLogger } from "./activity-log.js";
import { errorCodeOf } from "@crawl-automation/platform";
import { resourceGateCodes } from "@crawl-automation/platform/errors/resource-gate";
import { ApplicationFailure } from "@temporalio/common";

type Handler = (raw: unknown, signal: AbortSignal) => Promise<unknown>;

function guardAll(parts: WorkerParts, handlers: Record<string, Handler>) {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, guarded(name, handler, parts.log)]),
  );
}

/**
 * The Label workflow's steps that call neither a model nor the OCR API: plans, pages, label core, image preparation,
 * receipts, keyword screening, manifests, assembly, collection and the label Review. Each calls one processing step.
 */
export function labelActivities(parts: WorkerParts) {
  const steps = () => parts.label.steps;
  return guardAll(parts, {
    loadLabelPlan: (raw, signal) => steps().plans.load(raw, signal),
    prepareHtmlPage: (raw, signal) => steps().pagePreparation.run(raw, signal),
    preparePageText: (raw, signal) => steps().pageText.run(raw, signal),
    prepareLabelCore: (raw, signal) => steps().labelCore.run(raw, signal),
    prepareImageOcr: (raw, signal) => steps().imageTask.run(raw, signal),
    resolveOcrReceipt: (raw, signal) => steps().ocrReceipt.run(raw, signal),
    screenImageKeywords: (raw, signal) => steps().keywords.run(raw, signal),
    prepareLabelSource: (raw, signal) => steps().plans.source(raw, signal),
    inspectLabelImage: (raw, signal) => steps().selection.imageCheck(raw, signal),
    prepareLabelManifest: (raw, signal) => steps().plans.manifest(raw, signal),
    prepareSingleLabelManifest: (raw, signal) => steps().selection.manifest(raw, signal),
    resolveTextReceipt: (raw, signal) => steps().textReceipt.run(raw, signal),
    assembleLabelProduct: (raw, signal) => steps().assembly.run(raw, signal),
    collectLabelProduct: (raw, signal) => steps().collection.run(raw, signal),
    reviewLabelProduct: (raw, signal) => parts.labelReviews.review(raw, signal),
  });
}

/** Text and vision model calls, one per task; each client opens on this role's first call. */
export function modelActivities(parts: WorkerParts) {
  const models = () => parts.label.models;
  return guardAll(parts, {
    interpretText: async (raw, signal) => (await models().textStep()).run(raw, signal),
    interpretImage: async (raw, signal) => (await models().visionStep()).run(raw, signal),
  });
}

/** OCR API calls, one per image. */
export function ocrActivities(parts: WorkerParts) {
  return guardAll(parts, {
    ocrFile: (raw, signal) => parts.label.models.ocrStep().run(raw, signal),
  });
}

/** Resource permits for the workflows' permit gates: short ledger transactions, never a wait. */
export function resourceActivities(parts: WorkerParts) {
  return {
    ...guardAll(parts, { reserveResources: async (raw) => parts.admission.reserve(raw) }),
    releaseResources: (raw: unknown) => releaseResource(parts, raw),
  };
}

/** Release alone can repeat: the ledger checks the exact request and preserves released_at. */
async function releaseResource(parts: WorkerParts, raw: unknown): Promise<unknown> {
  const log = activityLogger(parts.log, "releaseResources", raw);
  try {
    const result = await parts.admission.release(raw);
    log.info("resource permit released");
    return result;
  } catch (error) {
    const code = errorCodeOf(error) ?? resourceGateCodes.releaseUnknown;
    log.error({ err: error, code }, "resource release failed");
    throw withCause(
      ApplicationFailure.create({
        message: "Resource release failed",
        type: code,
        nonRetryable: code === resourceGateCodes.identityConflict,
      }),
      error,
    );
  }
}
