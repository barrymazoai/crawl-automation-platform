import { defineErrors } from "@crawl-automation/platform";

const processing = (message: string) => ({ category: "PROCESSING" as const, message });
export const brandResearchErrors = defineErrors({
  "BRAND_RESEARCH.SETTINGS_INVALID": processing("Brand research settings are invalid."),
  "BRAND_RESEARCH.ANSWER_INVALID": processing(
    "The model answer does not satisfy the task contract.",
  ),
  "BRAND_RESEARCH.EVIDENCE_INVALID": processing(
    "Cited evidence is missing or fails integrity checks.",
  ),
  "BRAND_RESEARCH.SEARCH_UNAVAILABLE": processing("Brand research requires Codex web search."),
  "BRAND_RESEARCH.EXECUTION_FAILED": processing("Brand research execution failed."),
  "BRAND_RESEARCH.CLEANUP_FAILED": processing("The task-owned browser page could not be closed."),
});

export function invalidAnswer(task: string, reason: string): never {
  throw brandResearchErrors.create("BRAND_RESEARCH.ANSWER_INVALID", { details: { task, reason } });
}
