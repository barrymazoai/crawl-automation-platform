import type { CrossMarketListings } from "@crawl-automation/app";
import {
  CrossMarketListingsAnswerSchema,
  type CrossMarketListing,
} from "@crawl-automation/v3-contracts";
import type { SupplySmartRpc } from "./supply-smart-rpc.js";

/** Supply Smart answers at most this many external IDs per call (product-ingest-schema.ts, KAN-243 v2.3). */
const LOOKUP_LIMIT = 200;

/**
 * Read-only `product.getCrossMarketListings` (Supply Smart, KAN-243 v2.3): every listing of each Amazon external ID in
 * every country, with its latest label observation. Verified against the test environment on 2026-11-05.
 */
export class SupplySmartCrossMarketListings implements CrossMarketListings {
  constructor(private readonly rpc: SupplySmartRpc) {}

  async lookup(externalIds: string[], signal: AbortSignal) {
    const found = new Map<string, CrossMarketListing[]>();
    for (let start = 0; start < externalIds.length; start += LOOKUP_LIMIT) {
      const answer = await this.rpc.call(
        {
          api: "database",
          path: "product.getCrossMarketListings",
          input: { channel: "amazon", externalIds: externalIds.slice(start, start + LOOKUP_LIMIT) },
          answer: CrossMarketListingsAnswerSchema,
        },
        signal,
      );
      for (const result of answer.results) {
        found.set(result.externalId, result.listings);
      }
    }
    return found;
  }
}
