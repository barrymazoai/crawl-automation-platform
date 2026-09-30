import { defineErrors } from "../errors/define-errors.js";

const runtime = (message: string) => ({ category: "RUNTIME" as const, message });
const source = (message: string) => ({ category: "SOURCE" as const, message });

/**
 * Errors of the ScraperAPI client. The codes are stored in Reviews, so they keep the spelling the previous client
 * used; `SOURCE.ORIGIN_BLOCKED` is the refusal of a page address outside the allowed sites.
 */
export const scraperApiErrors = defineErrors({
  "SCRAPERAPI.CONFIG_INVALID": runtime("The ScraperAPI settings or request options are invalid."),
  "SCRAPERAPI.AUTH": runtime("ScraperAPI refused the key."),
  "SCRAPERAPI.THROTTLED": runtime("ScraperAPI refused the request as too many."),
  "SCRAPERAPI.PROVIDER_FAILURE": source("ScraperAPI could not fetch the page."),
  "SCRAPERAPI.EXECUTION_UNKNOWN": runtime("Whether ScraperAPI fetched the page is unknown."),
  "SCRAPERAPI.REDIRECT_UNVERIFIED": source("The page redirected somewhere that is not allowed."),
  "SOURCE.ORIGIN_BLOCKED": source("The page address is not on an allowed site."),
  "SOURCE.ACCESS_CHALLENGE": source("The site redirected to human or bot verification."),
});

export type ScraperApiErrorCode = keyof typeof scraperApiErrors.codes;
