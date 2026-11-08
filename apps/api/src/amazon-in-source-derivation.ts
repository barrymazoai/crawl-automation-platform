import { AMAZON_IN, AMAZON_US, amazonBrandSearchOn } from "@crawl-automation/channel-amazon";
import { brandScanErrors } from "@crawl-automation/channels-core";
import { isAppError, recordRecovery } from "@crawl-automation/platform";
import type { ScanSource } from "@crawl-automation/app";

/**
 * KAN-243 (owner 2026-11-08): amazon.in products of the brands that already have a company, found through the brand ID
 * their amazon.com source carries. A source without one numeric brand ID and a search keyword gives none.
 */
export function amazonInSourceFromAmazon(source: ScanSource): string | null {
  if (source.channel !== "amazon") {
    return null;
  }
  try {
    return amazonBrandSearchOn(source.url, AMAZON_US, AMAZON_IN);
  } catch (error) {
    if (!isAppError(error) || error.code !== brandScanErrors.code("BRAND_SCAN.URL")) {
      throw error;
    }
    recordRecovery(error, { operation: "amazon-in.source-derivation" });
    return null;
  }
}
