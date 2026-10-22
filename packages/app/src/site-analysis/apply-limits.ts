import type { SiteAnalysis } from "@crawl-automation/v3-contracts";

/** Only reasons and scope counts survive in the analysis row; the agent's verification file is archived separately. */
export function siteAnalysisLimitsReached(
  analysis: Pick<SiteAnalysis, "brands" | "limits" | "reasons">,
): boolean {
  if (
    analysis.brands.length > analysis.limits.maxBrands ||
    new Set(analysis.brands.map((brand) => brand.domain)).size > analysis.limits.maxDomains
  ) {
    return true;
  }
  return analysis.reasons.some((reason) =>
    /SITE_ANALYSIS\.LIMITS_REACHED|DTC\.ANALYSIS_LIMIT|\bmax(?:Brands|Pages|Domains)\b|\b(?:cap|limits?|budget)\b.{0,80}\b(?:reached|exceeded|exceeds|exhausted|hit)\b|\b(?:reached|exceeded|exceeds|exhausted|hit)\b.{0,80}\b(?:cap|limits?|budget)\b|(?:超过|达到).{0,20}上限|超限|预算.{0,20}耗尽/i.test(
      reason,
    ),
  );
}
