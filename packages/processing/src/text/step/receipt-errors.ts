import { defineErrors, type AppError } from "@crawl-automation/platform";

const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });

/** Errors of the text receipt step. Its Review keeps the code; any other failure is EVIDENCE_UNVERIFIED. */
export const textReceiptErrors = defineErrors({
  "TEXT_RECEIPT.IDENTITY_CONFLICT": artifact("The receipt belongs to a different text task."),
  "TEXT_RECEIPT.REVIEW_UNVERIFIED": artifact("The text Review could not be confirmed."),
  "TEXT_RECEIPT.TEXT_UNCONFIRMED": artifact("The text result is not registered and durable."),
  "TEXT_RECEIPT.EVIDENCE_UNVERIFIED": artifact("The text evidence could not be verified."),
  "TEXT_RECEIPT.LOCAL_UNVERIFIED": artifact("The receipt's own Review could not be kept locally."),
});

export type TextReceiptErrorCode = keyof typeof textReceiptErrors.codes;

/** A receipt failure from the registry. */
export function receiptFailure(code: TextReceiptErrorCode): AppError {
  return textReceiptErrors.create(code);
}
