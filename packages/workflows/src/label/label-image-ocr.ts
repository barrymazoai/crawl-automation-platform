import { recordWorkflowRecovery } from "../workflow-recovery.js";
import {
  KeywordReceiptSchema,
  OcrActivityOutcomeSchema,
  OcrReceiptOutcomeSchema,
  observationIdentity,
  type OcrActivityOutcome,
  type OcrInput,
} from "@crawl-automation/v3-contracts";
import { isCancellation } from "@temporalio/workflow";
import { isAdmissionFailure, noteSourceFailure, type LabelRun } from "./label-run.js";
import { sameJson } from "./same.js";
import { ImagePrepareSchema, type ImageSource, type State, type Status } from "./label-model.js";
import { isHeartbeatFailure } from "./activity-heartbeat.js";

/** An image after OCR: a final state (Review, rejected…), or its keyword selection for the label source step. */
export type OcrOutcome =
  { kind: "state"; state: State; ready: boolean } | { kind: "selection"; selection: unknown };

const stateOf = (source: ImageSource, status: Status, ready = true): OcrOutcome => ({
  kind: "state",
  state: { id: source.id, status },
  ready,
});

/**
 * OCR of one image up to its keyword screen: prepare the OCR task, OCR once, confirm by receipt, screen keywords.
 * Cheap and independent per image, so image-first tasks start it for every image at once.
 */
export async function ocrImage(run: LabelRun, source: ImageSource): Promise<OcrOutcome> {
  try {
    if (!(await run.stream.ready(source))) {
      const failure = run.stream.failure?.(source);
      if (failure) {
        return { kind: "state", state: failure, ready: false };
      }
      return stateOf(source, "unresolved", false);
    }
    const prepared = ImagePrepareSchema.parse(
      await run.call("activities", "prepareImageOcr", { plan: source.plan, receipt: null }),
    );
    if (prepared.status === "skipped") {
      // A PDF is not processed: like an image without a label, it is simply not a label source.
      return stateOf(source, "not_matched");
    }
    if (prepared.status === "review") {
      return prepared.operationId === source.plan.acquire.operationId
        ? {
            kind: "state",
            state: { id: source.id, status: "review", reviewId: prepared.reviewId },
            ready: true,
          }
        : stateOf(source, "rejected");
    }
    return await recognized(run, { source, task: prepared.task });
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    noteSourceFailure(run, source.id, error);
    return stateOf(source, "unresolved");
  }
}

async function recognized(
  run: LabelRun,
  at: { source: ImageSource; task: OcrInput },
): Promise<OcrOutcome> {
  const { source, task } = at;
  const owner = run.entry.input.owner;
  const planned =
    task.operationId === source.plan.ocrOperationId &&
    task.file.artifactId === source.plan.imageId &&
    sameJson(observationIdentity(task), owner);
  if (!planned) {
    return stateOf(source, "rejected");
  }
  const outcome = await ocrOnce(run, task);
  const receipt = OcrReceiptOutcomeSchema.parse(
    await run.call("activities", "resolveOcrReceipt", { input: task, outcome }),
  );
  if (receipt.status === "review") {
    return receipt.operationId === task.operationId
      ? {
          kind: "state",
          state: { id: source.id, status: "review", reviewId: receipt.reviewId },
          ready: true,
        }
      : stateOf(source, "rejected");
  }
  if (!sameJson(receipt.registration.input, task)) {
    return stateOf(source, "rejected");
  }
  const keywords = KeywordReceiptSchema.parse(
    await run.call("activities", "screenImageKeywords", receipt.registration),
  );
  const { selection } = keywords;
  const same =
    selection.ocrOperationId === task.operationId &&
    sameJson(selection.image, task.file) &&
    sameJson(selection.observation, owner);
  return same ? { kind: "selection", selection } : stateOf(source, "rejected");
}

/** The OCR call; a lost outcome leaves the receipt to inspect, and a permit failure stops the product. */
async function ocrOnce(run: LabelRun, task: OcrInput): Promise<OcrActivityOutcome | null> {
  try {
    return OcrActivityOutcomeSchema.parse(await run.call("ocr", "ocrFile", task));
  } catch (error) {
    if (isCancellation(error) || isAdmissionFailure(error) || isHeartbeatFailure(error)) {
      throw error;
    }
    recordWorkflowRecovery(error, { operation: "label-image-ocr" });
    return null;
  }
}
