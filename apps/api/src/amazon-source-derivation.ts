import {
  AMAZON_MAX_BYTES,
  AMAZON_US,
  amazonBrandLookupUrl,
  amazonBrandSearchFromLookup,
  amazonBrandSearchOn,
  type AmazonSite,
} from "@crawl-automation/channel-amazon";
import { brandScanErrors, type ListingPages } from "@crawl-automation/channels-core";
import { isAppError, recordRecovery } from "@crawl-automation/platform";
import type { ScanSource } from "@crawl-automation/app";

/**
 * KAN-243 (owner 2026-11-08, amazon.in; 2026-11-10, amazon.co.uk): a storefront's products of the brands that
 * already have a company, found through the brand ID their amazon.com source carries. A source without one numeric
 * brand ID and a search keyword gives none.
 */
export function amazonSourceFromAmazon(site: AmazonSite) {
  return (source: ScanSource): string | null => {
    if (source.channel !== "amazon") {
      return null;
    }
    try {
      return amazonBrandSearchOn(source.url, AMAZON_US, site);
    } catch (error) {
      if (!isAppError(error) || error.code !== brandScanErrors.code("BRAND_SCAN.URL")) {
        throw error;
      }
      recordRecovery(error, { operation: `${site.channel}.source-derivation` });
      return null;
    }
  };
}

/**
 * KAN-243 (owner 2026-11-08): brands are looked up by name on a storefront, one search page per brand through the
 * brand scans' ScraperAPI and archive. Owner 2026-11-09 ("把能找的全部找完"): every brand with a company is looked up,
 * so a source of any channel (a DTC site, GNC, an amazon.com search whose brand ID the storefront does not know) names
 * the brand; only its name is used. Lookup pages are archived under `<channel>-brand-lookup`, one per brand, and read
 * from the archive when looked up again.
 */
export function amazonSourceLookup(pages: Pick<ListingPages, "read">, site: AmazonSite) {
  return async (source: ScanSource, signal: AbortSignal): Promise<string | null> => {
    const read = await pages.read(
      {
        scanId: `${site.channel}-brand-lookup`,
        channel: site.channel,
        url: amazonBrandLookupUrl(source.brandName, site),
        label: `brand-${source.brandId}`,
        answer: "html",
        origins: [site.origin],
        maxBytes: AMAZON_MAX_BYTES,
        timeoutMs: 120_000,
      },
      signal,
    );
    return amazonBrandSearchFromLookup(read.body, source.brandName, site);
  };
}
