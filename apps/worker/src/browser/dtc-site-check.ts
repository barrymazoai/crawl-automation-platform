import { DtcSiteNutrition, SiteAnalysisPages, dtcAgentErrors } from "@crawl-automation/channel-dtc";
import type { BrowserReader } from "@crawl-automation/channels-core";
import { errorCodeOf } from "@crawl-automation/platform";
import type { SiteAnalysis, SiteAnalysisResult } from "@crawl-automation/v3-contracts";
import type { CoreParts } from "../core-parts.js";
import { dtcModelCall, verifyDtcModelPermit } from "./dtc-model.js";

/**
 * Owner 2026-10-08: before the DTC agent browses a site, its home page alone (archived, then closed) is checked for
 * nutrition products. Only a site with none is skipped; a check that cannot run lets the analysis continue.
 */
export function dtcSiteCheck(parts: CoreParts, browser: BrowserReader) {
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
      const pages = new SiteAnalysisPages({
        browser,
        publication: parts.publication,
        analysisId: input.analysisId,
        maxPages: 1,
        evidence: progress,
        anyOrigin: true,
      });
      const home = await pages.read(input.url, signal);
      const { decision, key } = await nutrition.check(home, signal);
      await progress(key);
      const { kind, reason } = decision;
      parts.log.info({ event: "DTC_SITE_CHECK", url: input.url, kind, reason }, "DTC site check");
      return kind === "not_nutrition" ? skipped([home.archiveKey, key], reason) : null;
    } catch (error) {
      signal.throwIfAborted();
      parts.log.warn(
        { event: "DTC_SITE_CHECK_UNAVAILABLE", url: input.url, code: errorCodeOf(error) },
        "DTC site check could not run; the analysis continues",
      );
      return null;
    }
  };
}

function skipped(archiveKeys: string[], reason: string): SiteAnalysisResult {
  return {
    state: "skipped",
    brands: [],
    archiveKeys,
    reasons: [`DTC.SITE_NOT_NUTRITION: ${reason}`],
  };
}
