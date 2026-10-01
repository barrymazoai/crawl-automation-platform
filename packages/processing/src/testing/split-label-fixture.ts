import {
  observationIdentity,
  type LabelImageCandidate,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import type { OrderedSource } from "../label/ordered-model.js";
import { visionFingerprint } from "./label-sources.js";
import { simpleImage, simpleLabel } from "./simple-label.js";

export function factsPanel(): LabelImageCandidate {
  return { ...simpleImage(), otherIngredients: null, ingredientsComplete: false };
}

export function ingredientsPanel(): LabelImageCandidate {
  return { ...simpleImage(), formula: null, formulaComplete: false };
}

export function croppedPanel(): LabelImageCandidate {
  const image = simpleImage();
  if (image.otherIngredients) {
    image.otherIngredients.items = image.otherIngredients.items.slice(0, 1);
  }
  return {
    ...image,
    ingredientsComplete: false,
    issues: [{ code: "UNREADABLE", detail: "The ingredients panel is cropped." }],
  };
}

/** Synthetic page coverage failure and image quality failure, matching the production state shape. */
export function splitReview(source: OrderedSource, image = croppedPanel()): ReviewRecord {
  const text = source.kind === "text";
  const owner = text ? observationIdentity(source.task) : source.task.input.selection.observation;
  const operationId = text ? source.task.operationId : source.task.input.operationId;
  return {
    schemaVersion: 1,
    reviewId: `review-${source.id}`,
    occurredAt: "2026-10-01T00:00:00.000Z",
    observation: owner,
    failure: {
      schemaVersion: 1,
      requestId: owner.requestId,
      observationId: owner.observationId,
      operationId,
      inputFingerprint: text ? source.task.inputFingerprint : visionFingerprint(source.task),
      stage: text ? "codex.text" : "codex.vision",
      category: "PROCESSING",
      code: text ? "TEXT.LABEL_COVERAGE_UNCERTAIN" : "VISION.LABEL_INGREDIENTS_INCOMPLETE",
      executionFact: "executed",
      evidenceKey: text
        ? `text-intents/${operationId}.json`
        : `v3/vision/${operationId}/response.json`,
      blockedBy: null,
      automaticRetry: false,
    },
    candidate: text
      ? { schema: "text-raw-response/1", value: { rawResponse: partialPageAnswer() } }
      : { schema: "label-extraction/1", value: JSON.parse(JSON.stringify(image)) },
    rawError: { name: "SyntheticReview", message: "Partial label", stack: null, details: {} },
    inspection: { kind: "none" },
  };
}

function partialPageAnswer() {
  return JSON.stringify({
    ...simpleLabel().wire,
    otherIngredients: null,
    ingredientsComplete: false,
    issues: [{ code: "INGREDIENTS_MISSING", detail: "No ingredient list on the page." }],
  });
}
