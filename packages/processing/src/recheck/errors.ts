import { defineErrors, errorCodeOf } from "@crawl-automation/platform";

const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });
export const recheckErrors = defineErrors({
  "RECHECK.IDENTITY_CONFLICT": artifact("Retained evidence names another task or product."),
  "RECHECK.EVIDENCE_UNAVAILABLE": artifact("Required retained evidence is unavailable."),
  "RECHECK.RECEIPT_UNVERIFIED": artifact("A registered source receipt could not be verified."),
  "RECHECK.PREPARATION_CHANGED": artifact(
    "Current preparation differs from the saved model input.",
  ),
  "RECHECK.UNSUPPORTED_REVIEW": artifact("This Review has no retained label assembly input."),
  "RECHECK.ANSWER_INVALID": artifact("The retained answer cannot be decoded."),
  "RECHECK.PREVIEW_REQUIRED": artifact("Publication requires an unexpired matching dry run."),
  "RECHECK.PREVIEW_CHANGED": artifact("Evidence or rules changed since the dry run."),
  "RECHECK.PUBLICATION_UNVERIFIED": artifact("Recovery publication could not be confirmed."),
});

export const recheckCode = (error: unknown) =>
  errorCodeOf(error) ?? recheckErrors.code("RECHECK.ANSWER_INVALID");
