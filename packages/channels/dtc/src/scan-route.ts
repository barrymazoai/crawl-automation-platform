import type { BrowserScanRequest } from "@crawl-automation/channels-core";
import { errorCodeOf } from "@crawl-automation/platform";
import { siteForBrandUrl } from "./address.js";
import type { DtcBrandScanResult } from "./brand-scan.js";
import type { DtcScanRelevance } from "./scan-relevance.js";
import type { DtcSitePolicy } from "./site-policy.js";

export type DtcScanDecision =
  { route: "platform"; site: string } | { route: "agent"; site: string; reason: string };

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
      /** Owner 2026-10-28: both routes' products are judged before the API queues them. */
      relevance?: Pick<DtcScanRelevance, "judge"> | undefined;
      onDecision?:
        ((decision: DtcScanDecision & { sourceUrl: string; scanId: string }) => void) | undefined;
    },
  ) {}

  async scan(request: BrowserScanRequest, signal: AbortSignal): Promise<DtcBrandScanResult> {
    const result = await this.route(request, signal);
    return this.deps.relevance ? this.deps.relevance.judge(result, signal) : result;
  }

  private async route(
    request: BrowserScanRequest,
    signal: AbortSignal,
  ): Promise<DtcBrandScanResult> {
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
      if (signal.aborted || code !== "DTC.PLATFORM_UNVERIFIED") {
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
