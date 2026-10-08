import {
  DtcSiteNutrition,
  SITE_TEXT_ROUND,
  SiteTextSchema,
  dtcAgentErrors,
} from "@crawl-automation/channel-dtc";
import { errorCodeOf, type EgoPages } from "@crawl-automation/platform";
import type { SiteAnalysis, SiteAnalysisResult } from "@crawl-automation/v3-contracts";
import type { CoreParts } from "../core-parts.js";
import { dtcModelCall, verifyDtcModelPermit } from "./dtc-model.js";

const READ_TIMEOUT_MS = 45_000;

/**
 * Owner 2026-10-08: before the DTC agent browses a site, its home page's visible text alone (one task page, closed
 * by the round) is checked for nutrition products. Only a site with none is skipped; a check that cannot run lets the
 * analysis continue.
 */
export function dtcSiteCheck(parts: CoreParts, browser: Pick<EgoPages, "round">) {
  const nutrition = new DtcSiteNutrition(
    parts.publication,
    dtcModelCall(parts, () => dtcAgentErrors.create("DTC.AGENT_REQUIRED")),
  );
  return async (
    input: SiteAnalysis,
    progress: (key: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<SiteAnalysisResult | null> => {
    await verifyDtcModelPermit(parts);
    try {
      const read = { url: input.url, timeoutMs: READ_TIMEOUT_MS };
      const page = SiteTextSchema.parse(await browser.round(SITE_TEXT_ROUND, { read }, signal));
      const { decision, key } = await nutrition.check(page, signal);
      await progress(key);
      const { kind, reason } = decision;
      parts.log.info({ event: "DTC_SITE_CHECK", url: input.url, kind, reason }, "DTC site check");
      return kind === "not_nutrition" ? skipped(key, reason) : null;
    } catch (error) {
      signal.throwIfAborted();
      parts.log.warn(
        {
          event: "DTC_SITE_CHECK_UNAVAILABLE",
          url: input.url,
          code: errorCodeOf(error),
          err: error,
        },
        "DTC site check could not run; the analysis continues",
      );
      return null;
    }
  };
}

function skipped(key: string, reason: string): SiteAnalysisResult {
  return {
    state: "skipped",
    brands: [],
    archiveKeys: [key],
    reasons: [`DTC.SITE_NOT_NUTRITION: ${reason}`],
  };
}
