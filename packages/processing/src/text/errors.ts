import { defineErrors, isAppError, type AppError } from "@crawl-automation/platform";
import { CodexError } from "@crawl-automation/platform";
import { recordedFact, stepFailure, type ExecutionFact } from "../step/step-failure.js";

export type { ExecutionFact } from "../step/step-failure.js";

const processing = (message: string) => ({ category: "PROCESSING" as const, message });
const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });

/**
 * Errors of the text step. The codes are stored in Reviews and read by later steps, so they keep their exact
 * spelling. `TEXT.LABEL_*` repeats a label check that failed (`LABEL.X` becomes `TEXT.LABEL_X`).
 */
export const textErrors = defineErrors({
  "TEXT.CITATION_INVALID": processing("A quote is not printed where the answer says it is."),
  "TEXT.MODEL_SCHEMA": processing("The model's answer does not match the answer format."),
  "TEXT.ROLE_INVALID": processing("A quoted ingredient is in the wrong section."),
  "TEXT.INGREDIENT_BOUNDARY": processing("An ingredient quote spans a list separator."),
  "TEXT.INPUT_INCOMPLETE": processing("The model reported the text as incomplete."),
  "TEXT.COVERAGE_UNCERTAIN": processing("Text was excluded without an accepted reason."),
  "TEXT.EXTRACTION_INCOMPLETE": processing("Printed words are neither extracted nor excluded."),
  "TEXT.PROTOCOL_MISMATCH": processing("The task asks for a protocol this worker does not speak."),
  "TEXT.LABEL_INVALID_OUTPUT": processing("The label answer could not be read."),
  "TEXT.LABEL_AMOUNT_EVIDENCE_CONFLICT": processing("An amount conflicts with its evidence."),
  "TEXT.LABEL_AMOUNT_MISSING": processing("A printed amount is missing."),
  "TEXT.LABEL_AMOUNT_STATE_CONFLICT": processing("An amount's status contradicts the text."),
  "TEXT.LABEL_AMOUNT_UNREADABLE": processing("An amount is unreadable."),
  "TEXT.LABEL_COMPLETENESS_CONFLICT": processing("Completeness flags contradict the answer."),
  "TEXT.LABEL_CORE_MISSING": processing("The label facts are missing."),
  "TEXT.LABEL_COVERAGE_UNCERTAIN": processing("Text was excluded without an accepted reason."),
  "TEXT.LABEL_EVIDENCE_UNCERTAIN": processing("The model reported uncertain evidence."),
  "TEXT.LABEL_EXTRACTION_INCOMPLETE": processing(
    "Printed words are neither extracted nor excluded.",
  ),
  "TEXT.LABEL_FORMULA_INCOMPLETE": processing("The formula is incomplete."),
  "TEXT.LABEL_GROUP_EMPTY": processing("A blend has no components."),
  "TEXT.LABEL_HEADER_VALUE_CONFLICT": processing("A header conflicts with its value."),
  "TEXT.LABEL_INGREDIENT_BOUNDARY": processing("Ingredient items overlap or are not separated."),
  "TEXT.LABEL_INGREDIENT_HEADING_INVALID": processing(
    "The ingredient heading is not a real heading.",
  ),
  "TEXT.LABEL_INGREDIENT_ROLE_INVALID": processing("An ingredient item is outside its section."),
  "TEXT.LABEL_INGREDIENTS_INCOMPLETE": processing("The ingredient list is incomplete."),
  "TEXT.LABEL_PARENT_INVALID": processing("A blend component points to a wrong parent."),
  "TEXT.LABEL_ROW_ORDER_INVALID": processing("Formula rows are not in printed order."),
  "TEXT.OUTPUT_LIMIT": processing("The answer or evidence is larger than allowed."),
  "TEXT.UPSTREAM_UNVERIFIED": artifact("The OCR result the text is read from is not verified."),
  "TEXT.SOURCE_CONFLICT": artifact("The source text does not match its evidence."),
  "TEXT.RANGE_INVALID": processing("The text range is empty or out of bounds."),
  "TEXT.EVIDENCE_UNAVAILABLE": artifact("The source text could not be read."),
  "TEXT.RESULT_INTEGRITY": artifact("A stored text result does not match its evidence."),
  "TEXT.RESULT_CONFLICT": artifact("A different text result is already stored for this task."),
  "TEXT.HANDOFF_INCOMPLETE": artifact("The text result was computed but not fully stored."),
  "TEXT.HANDOFF_UNKNOWN": artifact("Storing the text result could not be confirmed."),
  "TEXT.RESULT_NOT_DURABLE": artifact("A registered text result is missing from R2."),
  "TEXT.SOURCE_NOT_DURABLE": artifact("The source evidence is missing from R2."),
  "TEXT.REGISTRY_UNAVAILABLE": processing("This worker has no result registry."),
  "TEXT.PROVIDER_POLICY": processing("The model client would retry or switch models."),
  "TEXT.INVALID_INPUT": processing("The text task is invalid or for another model setup."),
  "TEXT.INTENT_UNKNOWN": artifact("Recording the intent to run the model could not be confirmed."),
  "TEXT.INTENT_CONFLICT": artifact("Another task holds this operation's intent."),
  "TEXT.EXECUTION_UNKNOWN": processing("The model may already have run for this task."),
  "TEXT.REVIEW_UNKNOWN": artifact("Writing the Review could not be confirmed."),
  "TEXT.CANCELLED": processing("The text task was cancelled."),
  "TEXT.UNCLASSIFIED": processing("The text task failed for an unrecorded reason."),
  "TEXT.CODEX_PRIVATE_CONFIG": processing("The model client's private config is invalid."),
  "TEXT.CODEX_CLOSED": processing("The model client is closed."),
});

export type TextErrorCode = keyof typeof textErrors.codes;

export function isTextErrorCode(code: string): code is TextErrorCode {
  return Object.hasOwn(textErrors.codes, code);
}

/** A text failure that records whether the model had already run and, when another error caused it, its code. */
export function textFailure(
  code: TextErrorCode,
  executionFact: ExecutionFact = "unknown",
  cause?: unknown,
): AppError {
  return stepFailure(textErrors, code, { fact: executionFact, cause });
}

/**
 * A failure the text step can classify: its own, the local store's, or the model client's. Anything else is
 * recorded as unclassified.
 */
export function isKnownTextFailure(error: unknown): error is AppError | CodexError {
  const own =
    isAppError(error) && (error.code.startsWith("TEXT.") || error.code.startsWith("STORAGE."));
  return own || error instanceof CodexError;
}

/** What a known failure says about the model having run; null when it does not say. */
export function executionFactOf(error: unknown): ExecutionFact | null {
  if (error instanceof CodexError) {
    return error.executionFact;
  }
  if (!isAppError(error)) {
    return null;
  }
  // A local-store failure never shows the model did not run: a journal may already exist.
  if (error.code.startsWith("STORAGE.")) {
    return "unknown";
  }
  if (!error.code.startsWith("TEXT.")) {
    return null;
  }
  return recordedFact(error);
}
