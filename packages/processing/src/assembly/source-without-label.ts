import { LabelTextWireSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { labelValidationErrors } from "../label/validation-errors.js";
import { textErrors } from "../text/errors.js";
import { assemblyErrors } from "./assembly-errors.js";
import { fail, type MergeState } from "./merge-state.js";

/** FORMULA_MISSING is a model issue, not a Review code. An empty label becomes CORE_MISSING. */
const SOURCE_WITHOUT_LABEL: readonly string[] = [
  textErrors.code("TEXT.LABEL_CORE_MISSING"),
  labelValidationErrors.code("LABEL.CORE_MISSING"),
];
const COVERAGE_UNCERTAIN = textErrors.code("TEXT.LABEL_COVERAGE_UNCERTAIN");
const RawTextResponseSchema = z.object({ rawResponse: z.string() });

/** A verified Review keeps the raw answer even when decoding failed. Never infer from prose. */
export function textReviewHasFormula(review: ReviewRecord): boolean | undefined {
  if (
    review.failure.code !== COVERAGE_UNCERTAIN ||
    review.candidate?.schema !== "text-raw-response/1"
  ) {
    return undefined;
  }
  const response = RawTextResponseSchema.safeParse(review.candidate.value);
  if (!response.success) {
    return undefined;
  }
  try {
    const parsed = LabelTextWireSchema.safeParse(JSON.parse(response.data.rawResponse));
    // FORMULA_MISSING corroborates absence; it cannot override an actually extracted formula.
    return parsed.success ? parsed.data.formula !== null : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined; // An unreadable answer is not proof of an absent label.
    }
    throw error;
  }
}

/** Only absent text labels can be skipped; partial labels and quality failures keep their policy. */
export function applySourceReview(
  state: MergeState,
  source: { id: string; codes: readonly string[]; withoutLabel?: boolean },
  completeLabel: boolean,
): void {
  const withoutLabel =
    state.sources.get(source.id)?.kind === "text" &&
    source.codes.length > 0 &&
    source.codes.every(
      (code) =>
        SOURCE_WITHOUT_LABEL.includes(code) ||
        (source.withoutLabel === true && code === COVERAGE_UNCERTAIN),
    );
  if (completeLabel && withoutLabel) {
    // Warning records have only id/code fields: retain the original codes beside the skip reason.
    state.warnings.push(
      { id: source.id, code: assemblyErrors.code("LABEL_PRODUCT.SOURCE_WITHOUT_LABEL") },
      ...source.codes.map((code) => ({ id: source.id, code })),
    );
    return;
  }
  source.codes.forEach((code) => fail(state, source.id, code));
}
