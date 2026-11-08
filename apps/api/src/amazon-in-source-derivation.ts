import {
  AMAZON_IN,
  AMAZON_MAX_BYTES,
  AMAZON_US,
  amazonBrandLookupUrl,
  amazonBrandSearchFromLookup,
  amazonBrandSearchOn,
} from "@crawl-automation/channel-amazon";
import { brandScanErrors, type ListingPages } from "@crawl-automation/channels-core";
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

/** Lookup pages are archived under this name, one per brand, and read from the archive when looked up again. */
const LOOKUP_ARCHIVE = "amazon-in-brand-lookup";

/**
 * KAN-243 (owner 2026-11-08): the brands with a company whose amazon.com source is a Store page (no brand ID) are
 * looked up by name on amazon.in, one search page per brand through the brand scans' ScraperAPI and archive. Owner
 * 2026-11-09 ("把能找的全部找完"): every brand with a company is looked up, so a source of any channel (a DTC site,
 * GNC, an amazon.com search whose brand ID amazon.in does not know) names the brand; only its name is used.
 */
export function amazonInSourceLookup(pages: Pick<ListingPages, "read">) {
  return async (source: ScanSource, signal: AbortSignal): Promise<string | null> => {
    const read = await pages.read(
      {
        scanId: LOOKUP_ARCHIVE,
        channel: "amazon-in",
        url: amazonBrandLookupUrl(source.brandName, AMAZON_IN),
        label: `brand-${source.brandId}`,
        answer: "html",
        origins: [AMAZON_IN.origin],
        maxBytes: AMAZON_MAX_BYTES,
        timeoutMs: 120_000,
      },
      signal,
    );
    return amazonBrandSearchFromLookup(read.body, source.brandName, AMAZON_IN);
  };
}
