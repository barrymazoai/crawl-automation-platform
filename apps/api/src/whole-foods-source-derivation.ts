import { amazonBrandFilterId, amazonBrandSearchName } from "@crawl-automation/channel-amazon";
import { wholeFoodsBrandSearchUrl } from "@crawl-automation/channels-wholefoods";
import { brandScanErrors } from "@crawl-automation/channels-core";
import { wholeFoodsErrors } from "@crawl-automation/channels-wholefoods";
import { isAppError, recordRecovery } from "@crawl-automation/platform";
import type { ScanSource } from "@crawl-automation/app";

const addressRefusals: ReadonlySet<string> = new Set([
  brandScanErrors.code("BRAND_SCAN.URL"),
  wholeFoodsErrors.code("WHOLEFOODS.URL"),
]);

/** Source keywords identify the retail brand; the brand record may name its holding company. */
export function wholeFoodsSourceFromAmazon(source: ScanSource): string | null {
  if (source.channel !== "amazon") {
    return null;
  }
  try {
    const name = amazonBrandSearchName(source.url);
    const amazonBrandId = amazonBrandFilterId(source.url);
    return amazonBrandId && name ? wholeFoodsBrandSearchUrl({ name, amazonBrandId }) : null;
  } catch (error) {
    if (!isAppError(error) || !addressRefusals.has(error.code)) {
      throw error;
    }
    recordRecovery(error, { operation: "wholefoods.source-derivation" });
    return null;
  }
}
