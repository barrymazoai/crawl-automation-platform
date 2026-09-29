import { defineErrors, type AppError } from "@crawl-automation/platform";

const processing = (message: string) => ({ category: "PROCESSING" as const, message });

/**
 * Errors of a channel's label-core reader (the hook that picks the label facts text out of a product page). The codes
 * are stored in Reviews, so they keep their exact spelling.
 */
export const labelCoreErrors = defineErrors({
  "LABEL_CORE.SOURCE_LIMIT": processing("The page is too large or too deeply nested to read."),
  "LABEL_CORE.SOURCE_UNSUPPORTED": processing("The page is not in the form this reader expects."),
  "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS": processing("The page does not hold exactly one label."),
  "LABEL_CORE.TABLE_SCOPE_AMBIGUOUS": processing(
    "The label does not hold exactly one facts table.",
  ),
  "LABEL_CORE.TABLE_UNVERIFIED": processing("The facts table lacks its serving headings."),
  "LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS": processing(
    "The other-ingredients section is not clear.",
  ),
  "LABEL_CORE.OUTPUT_LIMIT": processing("The label facts text is longer than allowed."),
});

export type LabelCoreErrorCode = keyof typeof labelCoreErrors.codes;

export const labelCoreFailure = (code: LabelCoreErrorCode): AppError =>
  labelCoreErrors.create(code);
