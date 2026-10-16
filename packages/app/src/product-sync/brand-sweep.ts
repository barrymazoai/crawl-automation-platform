import type { Logger } from "@crawl-automation/platform";
import type { MatchBrandsResult } from "./brand-company-model.js";

export interface MarketplaceBrandSweepSettings {
  /** Brands checked against Supply Smart per round: never checked, or unmatched for a day. */
  matchLimit: number;
  /** Marketplace website runs alive at once (2026-10-15: 267 at once ran the worker out of memory). */
  maxLiveRuns: number;
}

/**
 * Owner 2026-10-16: new brands need no hand. Each sync round first matches brands that now have completed products to
 * Supply Smart companies, then starts the existing website run (find or create the company) for those still
 * unmatched — each brand once, a bounded number alive at once. Their products go out once matched.
 */
export class MarketplaceBrandSweep {
  constructor(
    private readonly deps: {
      /** The API's `productSync.matchBrands` and `brandEnrichment.startMarketplaceBrands`: one path with operators. */
      api: {
        matchBrands(limit: number, signal: AbortSignal): Promise<MatchBrandsResult>;
        startMarketplaceBrands(limit: number, signal: AbortSignal): Promise<unknown[]>;
      };
      runs: { live(): Promise<number> };
      settings: MarketplaceBrandSweepSettings;
      log: Logger;
    },
  ) {}

  async sweep(signal: AbortSignal): Promise<void> {
    const { settings } = this.deps;
    const matched = await this.deps.api.matchBrands(settings.matchLimit, signal);
    signal.throwIfAborted();
    const live = await this.deps.runs.live();
    // The start API takes at most 100 brands per call.
    const free = Math.min(100, settings.maxLiveRuns - live);
    const started = free > 0 ? await this.deps.api.startMarketplaceBrands(free, signal) : [];
    this.deps.log.info(
      { ...matched, errors: matched.errors.length, live, started: started.length },
      "marketplace brands",
    );
  }
}
