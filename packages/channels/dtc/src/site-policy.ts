import type {
  CatalogPolicy,
  PlatformContext,
  PlatformProduct,
  StorePlatform,
} from "@crawl-automation/channels-core";
import type { ListScroll } from "@crawl-automation/platform";

export interface DtcSitePolicy {
  siteKey: string;
  platform: StorePlatform | "unverified";
  origins: readonly string[];
  catalogUrl: string | null;
  imageOrigins: readonly string[];
  productPath: RegExp;
  productSelector?: string;
  catalog: Omit<CatalogPolicy, "url">;
  scroll: ListScroll;
  /** A site's small extraction hook, still pure and still reading the retained DOM. */
  readProduct?: (document: Document, context: PlatformContext) => PlatformProduct;
}

export const DTC_PAGE_LIMITS = { maxBytes: 6 * 1024 * 1024, timeoutMs: 75_000 };
export const DTC_BROWSER_POLICY = { readySelector: "main, #MainContent, .site-main" };

const catalog = {
  catalogSelector: "#product-grid, .collection .grid, ul.products, [data-product-grid]",
  productLinkSelector: 'a[href*="/products/"], a.woocommerce-LoopProduct-link',
  nextSelector: 'a[rel="next"], .pagination a.next, a.next.page-numbers',
  emptySelector:
    '.collection--empty, .woocommerce-info[data-empty="true"], [data-catalog-empty="true"]',
};
const scroll: ListScroll = {
  itemSelector: "",
  moreTexts: ["Load more", "Show more", "View more"],
  maxRounds: 40,
  stableRounds: 3,
  settleMs: 800,
};

function catalogItemSelector(policy: DtcSitePolicy["catalog"]): string {
  return policy.catalogSelector
    .split(",")
    .flatMap((root) =>
      policy.productLinkSelector.split(",").map((link) => `${root.trim()} ${link.trim()}`),
    )
    .join(", ");
}

/** An unverified site is addressable, but reading waits for its browser-checked policy. */
export function dtcSitePolicy(
  site: Pick<DtcSitePolicy, "siteKey" | "platform" | "catalogUrl"> &
    Partial<Omit<DtcSitePolicy, "siteKey" | "platform" | "catalogUrl">>,
): DtcSitePolicy {
  const origins = site.origins ?? [`https://${site.siteKey}`];
  const listing = site.catalog ?? catalog;
  return {
    origins,
    imageOrigins: [...origins, "https://cdn.shopify.com"],
    productPath: /^\/(?:collections\/[^/]+\/)?products?\/[^/]+\/?$/,
    ...site,
    catalog: listing,
    scroll: site.scroll ?? { ...scroll, itemSelector: catalogItemSelector(listing) },
  };
}

/** The first requested site remains unverified; no platform is inferred from its refused plain request. */
export const DTC_SITES: readonly DtcSitePolicy[] = [
  dtcSitePolicy({
    siteKey: "nutriessential.com",
    platform: "unverified",
    catalogUrl: null,
    origins: ["https://nutriessential.com", "https://www.nutriessential.com"],
  }),
];
