import type { ScraperApiOptions } from "@crawl-automation/platform";
import { WHOLE_FOODS_STORE } from "./whole-foods-store.js";

/** Confirm this documented cookie on a real HTTP capture; price parsing still verifies the shown store. */
export const WHOLE_FOODS_HTTP_OPTIONS: Partial<ScraperApiOptions> = {
  headers: { cookie: `wfm_store_d8=${WHOLE_FOODS_STORE.storeId}` },
};
