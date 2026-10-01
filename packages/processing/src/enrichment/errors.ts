import { defineErrors } from "@crawl-automation/platform";

const processing = (message: string) => ({ category: "PROCESSING" as const, message });
export const enrichmentErrors = defineErrors({
  "ENRICH.INPUT_MISSING": processing("The collected formula or its product identity is missing."),
  "ENRICH.OUTPUT_INVALID": processing(
    "The enrichment response is invalid or unsupported by its input.",
  ),
  "ENRICH.EXECUTION_PENDING": processing(
    "This input already has an execution claim; never call again.",
  ),
  "ENRICH.INTEGRITY": processing("The enrichment record does not match its retained evidence."),
  "ENRICH.UNCLASSIFIED": processing("Enrichment failed; the original cause is retained."),
  "ENRICH.SETTINGS_MISSING": processing(
    "Enrichment requires the shared text model queue and permit.",
  ),
  "ENRICH.BACKFILL_INVALID": processing(
    "The approved backfill count does not match the bounded list.",
  ),
});
