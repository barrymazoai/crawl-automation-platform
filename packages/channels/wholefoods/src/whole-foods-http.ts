import type { ScraperApiOptions } from "@crawl-automation/platform";
import { WHOLE_FOODS_STORE, wholeFoodsStoreCookie } from "./whole-foods-store.js";

/** The store cookie on every product capture; parsing still refuses a page priced for another store. */
export const WHOLE_FOODS_HTTP_OPTIONS: Partial<ScraperApiOptions> = {
  headers: { cookie: wholeFoodsStoreCookie(WHOLE_FOODS_STORE) },
};
