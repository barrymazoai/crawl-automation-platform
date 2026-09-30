import type { HttpPolicy } from "@crawl-automation/channels-core";
import type { ListScroll } from "@crawl-automation/platform";
import { WHOLE_FOODS_ORIGIN } from "./whole-foods-address.js";
import { WHOLE_FOODS_PRODUCT_LINK } from "./whole-foods-listing.js";

/** Which site Whole Foods pages come from, and their size and time limits. */
export const WHOLE_FOODS_PAGE_POLICY: HttpPolicy = {
  origins: [WHOLE_FOODS_ORIGIN],
  maxBytes: 8_388_608,
  timeoutMs: 90_000,
};

/**
 * Scrolling a brand search to its end: new products appear as the page is scrolled or "load more" is pressed. The
 * list has ended when three rounds in a row add nothing and no "load more" button is left; 60 rounds is the most a
 * scan reads, and a list stopped there is not complete.
 */
export const WHOLE_FOODS_LIST_SCROLL: ListScroll = {
  itemSelector: WHOLE_FOODS_PRODUCT_LINK,
  moreTexts: ["load more", "show more", "see more"],
  maxRounds: 60,
  stableRounds: 3,
  settleMs: 2_500,
};
