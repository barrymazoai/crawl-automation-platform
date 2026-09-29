import { defineErrors, type AppError } from "@crawl-automation/platform";

const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });
const validation = (message: string) => ({ category: "VALIDATION" as const, message });
const ingest = (message: string) => ({ category: "INGEST" as const, message });

/** Errors of label assembly, packaging evidence and collection. The codes are stored in Reviews and kept as they are. */
export const assemblyErrors = defineErrors({
  "LABEL_PRODUCT.TEXT_UNVERIFIED": artifact(
    "A text source is not registered and durable, so assembly cannot read it.",
  ),
  "LABEL_PRODUCT.IDENTITY_CONFLICT": artifact("A label source belongs to another product."),
  "LABEL_PRODUCT.BARRIER_INCOMPLETE": validation("Not every label source has finished."),
  "LABEL_PRODUCT.RECEIPT_INVALID": artifact("A label source's receipt contradicts its evidence."),
  "LABEL_PRODUCT.REVIEW_UNVERIFIED": artifact("A Review could not be confirmed."),
  "LABEL_PRODUCT.PACKAGING_UNVERIFIED": artifact("The packaging evidence could not be verified."),
  "LABEL_PRODUCT.TEXT_SCOPE_UNVERIFIED": artifact(
    "A text answer does not cover its whole document.",
  ),
  "LABEL_PRODUCT.HANDOFF_UNVERIFIED": artifact("Publishing the assembly could not be confirmed."),
  "LABEL_PRODUCT.HANDOFF_PENDING": artifact(
    "An earlier publication of this product never finished.",
  ),
  "LABEL_PRODUCT.OUTPUT_LIMIT": artifact("The assembly is larger than allowed."),
  "LABEL_PRODUCT.NOT_READY": validation("The product is not ready to collect."),
  "LABEL_PRODUCT.EVIDENCE_UNRESOLVED": artifact("A label source's evidence could not be resolved."),
  "LABEL_COLLECTION.INTEGRITY": ingest("A collected product does not match its hash."),
  "LABEL_COLLECTION.CONFLICT": ingest(
    "A different product is already collected for this operation.",
  ),
  "LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED": ingest(
    "This observation is already collected.",
  ),
  "LABEL_COLLECTION.REGISTRATION_UNKNOWN": ingest("Collecting the product could not be confirmed."),
  "PACKAGING.SOURCE_LIMIT": validation("Packaging evidence needs 1 to 100 documents."),
  "PACKAGING.SOURCE_IDENTITY_CONFLICT": artifact(
    "A packaging document belongs to another product.",
  ),
  "PACKAGING.DUPLICATE_SOURCE": artifact("A packaging document is listed twice."),
});

export type AssemblyErrorCode = keyof typeof assemblyErrors.codes;

export const assemblyFailure = (code: AssemblyErrorCode, cause?: unknown): AppError =>
  assemblyErrors.create(code, cause === undefined ? {} : { cause });
