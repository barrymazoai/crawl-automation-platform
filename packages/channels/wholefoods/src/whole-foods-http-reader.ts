import type { BrandScanReader } from "@crawl-automation/channels-core";
import { wholeFoodsBrandSourceUrl, WHOLE_FOODS_ORIGIN } from "./whole-foods-address.js";
import {
  WHOLE_FOODS_HTTP_SCAN_DEFAULTS,
  type WholeFoodsHttpScanSettings,
} from "./whole-foods-http-settings.js";
import { parseWholeFoodsSearchPage, wholeFoodsSearchComplete } from "./whole-foods-search-page.js";
import { wholeFoodsSearchUrl } from "./whole-foods-search-request.js";
import { scanWholeFoodsSearch } from "./whole-foods-search-scan.js";

/** JSON list policy on the existing archived HTTP brand-scan path. */
export function createWholeFoodsHttpReader(
  settings: WholeFoodsHttpScanSettings = WHOLE_FOODS_HTTP_SCAN_DEFAULTS,
): BrandScanReader {
  return {
    sourceUrl: wholeFoodsBrandSourceUrl,
    origins: [WHOLE_FOODS_ORIGIN],
    answer: "json",
    maxPages: settings.maxPages,
    maxBytes: 8 * 1024 * 1024,
    pageUrl: (source, page) =>
      wholeFoodsSearchUrl(wholeFoodsBrandSourceUrl(source), page, settings),
    parsePage: (input) => parseWholeFoodsSearchPage({ ...input, size: settings.size }),
    complete: wholeFoodsSearchComplete,
    readList: (context) => scanWholeFoodsSearch(context, settings),
  };
}
