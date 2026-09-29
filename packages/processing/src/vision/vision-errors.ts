import { defineErrors, type AppError } from "@crawl-automation/platform";
import { stepFailure, type ExecutionFact } from "../step/step-failure.js";

const processing = (message: string) => ({ category: "PROCESSING" as const, message });
const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });

/** A label check that failed on an image answer (`LABEL.X` becomes `VISION.LABEL_X`). */
const labelCheck = (message: string) =>
  processing(`The image answer failed a label check: ${message}`);

/**
 * Errors of the vision step, its results and its receipt. The codes are stored in Reviews, so they keep their exact
 * spelling.
 */
export const visionErrors = defineErrors({
  "VISION.INVALID_INPUT": processing("The vision task is invalid."),
  "VISION.CONFIG_MISMATCH": processing("The task is for another vision setup."),
  "VISION.EVIDENCE_UNRESOLVED": artifact("The OCR selection or the image could not be verified."),
  "VISION.INPUT_CONFLICT": artifact("Another task holds this operation's intent."),
  "VISION.EXECUTION_UNKNOWN": processing("The model may already have run for this task."),
  "VISION.INTENT_UNVERIFIED": artifact(
    "Recording the intent to run the model could not be confirmed.",
  ),
  "VISION.OUTPUT_LIMIT": processing("The model answer is larger than allowed."),
  "VISION.INVALID_OUTPUT": processing("The model answer could not be read."),
  "VISION.LOCAL_EVIDENCE_CONFLICT": artifact("The answer kept locally does not match."),
  "VISION.HANDOFF_PENDING": artifact("The answer is kept but not fully stored or registered."),
  "VISION.HANDOFF_UNVERIFIED": artifact("The answer in R2 does not match the one kept locally."),
  "VISION.HANDOFF_UNKNOWN": artifact("Storing the vision result could not be confirmed."),
  "VISION.HANDOFF_INCOMPLETE": artifact("The intent or the answer is missing."),
  "VISION.EVIDENCE_CONFLICT": artifact("The stored answer does not belong to this task."),
  "VISION.SOURCE_NOT_DURABLE": artifact("The image is missing from R2."),
  "VISION.RESULT_NOT_ACCEPTED": processing("The stored answer is a Review, not a result."),
  "VISION.RESULT_INTEGRITY": artifact("A stored vision result does not match its evidence."),
  "VISION.RESULT_CONFLICT": artifact("A different vision result is registered for this task."),
  "VISION.RESULT_NOT_DURABLE": artifact("A registered vision result is missing from R2."),
  "VISION.RESULT_NOT_REGISTERED": artifact("The vision result is not registered."),
  "VISION.REGISTRY_UNAVAILABLE": processing("This worker has no result registry."),
  "VISION.LEGACY_PROTOCOL_UNSUPPORTED": processing("The task uses the old vision answer format."),
  "VISION.LABEL_PROTOCOL_REQUIRED": processing("The task does not use a label answer format."),
  "VISION.REVIEW_UNVERIFIED": artifact("The vision Review could not be confirmed."),
  "VISION.CANCELLED": processing("The vision task was cancelled."),
  "VISION.UNRESOLVED": processing("The vision task failed for an unrecorded reason."),
  "VISION.ROLE_INVALID": processing("A blend component points to a wrong parent."),
  "VISION.EVIDENCE_UNCERTAIN": processing("The model reported uncertain evidence."),
  "VISION.CORE_MISSING": processing("The label facts are missing or incomplete."),
  "VISION.LABEL_AMOUNT_EVIDENCE_CONFLICT": labelCheck("an amount conflicts with its evidence."),
  "VISION.LABEL_AMOUNT_MISSING": labelCheck("a printed amount is missing."),
  "VISION.LABEL_AMOUNT_STATE_CONFLICT": labelCheck("an amount's status contradicts the image."),
  "VISION.LABEL_AMOUNT_UNREADABLE": labelCheck("an amount is unreadable."),
  "VISION.LABEL_COMPLETENESS_CONFLICT": labelCheck("completeness flags contradict the answer."),
  "VISION.LABEL_CORE_MISSING": labelCheck("the label facts are missing."),
  "VISION.LABEL_EVIDENCE_UNCERTAIN": labelCheck("the model reported uncertain evidence."),
  "VISION.LABEL_FORMULA_INCOMPLETE": labelCheck("the formula is incomplete."),
  "VISION.LABEL_GROUP_EMPTY": labelCheck("a blend has no components."),
  "VISION.LABEL_HEADER_VALUE_CONFLICT": labelCheck("a header conflicts with its value."),
  "VISION.LABEL_INGREDIENT_BOUNDARY": labelCheck("ingredient items overlap or are not separated."),
  "VISION.LABEL_INGREDIENT_HEADING_INVALID": labelCheck("the ingredient heading is not a heading."),
  "VISION.LABEL_INGREDIENT_ROLE_INVALID": labelCheck("an ingredient item is outside its section."),
  "VISION.LABEL_INGREDIENTS_INCOMPLETE": labelCheck("the ingredient list is incomplete."),
  "VISION.LABEL_PARENT_INVALID": labelCheck("a blend component points to a wrong parent."),
  "VISION.PRIVATE_CONFIG": processing("The vision model's private config is invalid."),
  "VISION.CODEX_CLOSED": processing("The vision model is closed."),
});

export type VisionErrorCode = keyof typeof visionErrors.codes;

export function isVisionErrorCode(code: string): code is VisionErrorCode {
  return Object.hasOwn(visionErrors.codes, code);
}

/** A vision failure that records whether the model had already run and, when another error caused it, its code. */
export function visionFailure(
  code: VisionErrorCode,
  fact: ExecutionFact = "unknown",
  cause?: unknown,
): AppError {
  return stepFailure(visionErrors, code, { fact, cause });
}
