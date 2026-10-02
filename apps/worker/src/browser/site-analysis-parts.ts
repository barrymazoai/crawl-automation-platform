import { PostgresSiteAnalyses } from "@crawl-automation/adapters";
import { SiteAnalysisRunner } from "@crawl-automation/app";
import { DtcSiteAnalyzer, SiteAnalysisPages } from "@crawl-automation/channel-dtc";
import type { EgoPages } from "@crawl-automation/platform";
import type { CoreParts } from "../core-parts.js";

export function siteAnalysisRunner(parts: CoreParts, browser: EgoPages) {
  return new SiteAnalysisRunner({
    store: new PostgresSiteAnalyses(parts.database),
    analyze: (input, evidence, signal) => {
      const pages = new SiteAnalysisPages({
        browser,
        publication: parts.publication,
        analysisId: input.analysisId,
        maxPages: input.limits.maxPages,
        evidence,
      });
      return new DtcSiteAnalyzer(pages, input.limits).analyze(input.url, signal);
    },
  });
}
