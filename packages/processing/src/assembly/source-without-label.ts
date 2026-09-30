import { labelValidationErrors } from "../label/validation-errors.js";
import { textErrors } from "../text/errors.js";
import { assemblyErrors } from "./assembly-errors.js";
import { fail, type MergeState } from "./merge-state.js";

/** FORMULA_MISSING is a model issue, not a Review code. An empty label becomes CORE_MISSING. */
const SOURCE_WITHOUT_LABEL: readonly string[] = [
  textErrors.code("TEXT.LABEL_CORE_MISSING"),
  labelValidationErrors.code("LABEL.CORE_MISSING"),
];

/** Only absent text labels can be skipped; partial labels and quality failures keep their policy. */
export function applySourceReview(
  state: MergeState,
  source: { id: string; codes: readonly string[] },
  completeLabel: boolean,
): void {
  const withoutLabel =
    state.sources.get(source.id)?.kind === "text" &&
    source.codes.length > 0 &&
    source.codes.every((code) => SOURCE_WITHOUT_LABEL.includes(code));
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
