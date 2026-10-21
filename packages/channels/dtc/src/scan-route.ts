import type { BrowserScanRequest } from "@crawl-automation/channels-core";
import { errorCodeOf } from "@crawl-automation/platform";
import { siteForBrandUrl } from "./address.js";
import type { DtcBrandScanResult } from "./brand-scan.js";
import type { DtcSitePolicy } from "./site-policy.js";

export type DtcScanDecision =
  { route: "platform"; site: string } | { route: "agent"; site: string; reason: string };

/** Only catalog-shape verdicts can hand a platform site to the recorded agent method. */
const CATALOG_SHAPE_FAILURES: ReadonlySet<string> = new Set([
  "DTC.LISTING_UNVERIFIED",
  "DTC.PLATFORM_UNVERIFIED",
  "BRAND_SCAN.PAGINATION",
]);

export class DtcScanRoute {
  constructor(
    private readonly deps: {
      platform: {
        scan(request: BrowserScanRequest, signal: AbortSignal): Promise<DtcBrandScanResult>;
      };
      agent: {
        scan(request: BrowserScanRequest, signal: AbortSignal): Promise<DtcBrandScanResult>;
      };
      sites: readonly DtcSitePolicy[];
      onDecision?:
        ((decision: DtcScanDecision & { sourceUrl: string; scanId: string }) => void) | undefined;
    },
  ) {}

  async scan(request: BrowserScanRequest, signal: AbortSignal): Promise<DtcBrandScanResult> {
    const site = siteForBrandUrl(request.sourceUrl, this.deps.sites);
    if (site.capture !== "platform") {
      this.decide(request, { route: "agent", site: site.siteKey, reason: "site_policy" });
      return this.deps.agent.scan(request, signal);
    }
    this.decide(request, { route: "platform", site: site.siteKey });
    try {
      return await this.deps.platform.scan(request, signal);
    } catch (error) {
      const code = errorCodeOf(error);
      if (signal.aborted || !code || !CATALOG_SHAPE_FAILURES.has(code)) {
        throw error;
      }
      this.decide(request, { route: "agent", site: site.siteKey, reason: code });
      return this.deps.agent.scan(request, signal);
    }
  }

  private decide(request: BrowserScanRequest, decision: DtcScanDecision) {
    this.deps.onDecision?.({ ...decision, sourceUrl: request.sourceUrl, scanId: request.scanId });
  }
}
