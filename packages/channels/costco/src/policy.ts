import type { HttpPolicy } from "@crawl-automation/channels-core";
import type { ListScroll, ScraperApiOptions } from "@crawl-automation/platform";
import { COSTCO_ORIGIN } from "./address.js";
import { COSTCO_PRODUCT_LINK } from "./listing.js";

export const COSTCO_PAGE_POLICY: HttpPolicy = {
  origins: [COSTCO_ORIGIN],
  maxBytes: 8_388_608,
  timeoutMs: 90_000,
};
export const COSTCO_IMAGE_ORIGINS = [
  COSTCO_ORIGIN,
  "https://gdx-assets.costco.com",
  "https://images.costco-static.com",
];
export const COSTCO_HTTP_OPTIONS: Partial<ScraperApiOptions> = { render: false };
export const COSTCO_LIST_SCROLL: ListScroll = {
  itemSelector: COSTCO_PRODUCT_LINK,
  moreTexts: ["show more", "load more", "next", "next page"],
  moreSelector:
    'button, a[role=button], a[rel=next], a[aria-label="Next"], a[aria-label="Next page"]',
  maxRounds: 60,
  stableRounds: 3,
  settleMs: 2_500,
};
