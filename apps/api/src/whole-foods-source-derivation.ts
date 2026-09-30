import { amazonBrandFilterId } from "@crawl-automation/channel-amazon";
import { wholeFoodsBrandSearchUrl } from "@crawl-automation/channels-wholefoods";
import { brandScanErrors } from "@crawl-automation/channels-core";
import { wholeFoodsErrors } from "@crawl-automation/channels-wholefoods";
import { isAppError, recordRecovery } from "@crawl-automation/platform";
import type { ScanSource } from "@crawl-automation/app";

const addressRefusals: ReadonlySet<string> = new Set([
  brandScanErrors.code("BRAND_SCAN.URL"),
  wholeFoodsErrors.code("WHOLEFOODS.URL"),
]);

/** The URL itself must be a valid Amazon Brand-filter search. Source names are existing brand identities. */
export function wholeFoodsSourceFromAmazon(source: ScanSource): string | null {
  try {
    const amazonBrandId = amazonBrandFilterId(source.url);
    return amazonBrandId
      ? wholeFoodsBrandSearchUrl({ name: source.brandName, amazonBrandId })
      : null;
  } catch (error) {
    if (!isAppError(error) || !addressRefusals.has(error.code)) {
      throw error;
    }
    recordRecovery(error, { operation: "wholefoods.source-derivation" });
    return null;
  }
}
