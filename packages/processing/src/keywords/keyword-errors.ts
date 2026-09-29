import { defineErrors } from "@crawl-automation/platform";

const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });

/** Errors of keyword screening. The codes are stored in Reviews, so they keep their exact spelling. */
export const keywordErrors = defineErrors({
  "SCREEN.UPSTREAM_UNVERIFIED": artifact("The OCR result is not registered and durable."),
  "SCREEN.SOURCE_CONFLICT": artifact("The OCR result belongs to another image or observation."),
  "SCREEN.EVIDENCE_MISMATCH": artifact("The keyword decision does not follow from the OCR text."),
  "SCREEN.PUBLICATION_CONFLICT": artifact("A different keyword decision is already stored."),
  "SCREEN.HANDOFF_PENDING": artifact("An earlier keyword publication never finished."),
  "SCREEN.EVIDENCE_UNRESOLVED": artifact("The keyword evidence could not be resolved."),
  "SCREEN.REVIEW_UNVERIFIED": artifact("The keyword Review could not be confirmed."),
});

export type KeywordErrorCode = keyof typeof keywordErrors.codes;

export const keywordFailure = (code: KeywordErrorCode, cause?: unknown) =>
  keywordErrors.create(code, cause === undefined ? {} : { cause });
