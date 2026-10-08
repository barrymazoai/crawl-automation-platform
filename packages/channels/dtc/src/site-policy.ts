import type {
  CatalogPolicy,
  PlatformContext,
  PlatformProduct,
  StorePlatform,
} from "@crawl-automation/channels-core";
import type { ListScroll } from "@crawl-automation/platform";
import { dtcPreparationScript } from "./page-preparation.js";

export interface DtcSitePolicy {
  siteKey: string;
  /** Retain a pre-existing single-brand policy when discovered catalogs share its domain. */
  legacySite?: DtcSitePolicy;
  kind: "single-brand" | "multi-brand";
  platform: StorePlatform | "unverified";
  origins: readonly string[];
  catalogUrl: string | null;
  brands: readonly DtcBrandCatalog[];
  imageOrigins: readonly string[];
  productPath: RegExp;
  productSelector?: string;
  catalog: Omit<CatalogPolicy, "url">;
  scroll: ListScroll;
  /** A site's small extraction hook, still pure and still reading the retained DOM. */
  readProduct?: (document: Document, context: PlatformContext) => PlatformProduct;
}

export interface DtcBrandCatalog {
  brand: string;
  catalogUrl: string;
}

type SiteInput = Pick<DtcSitePolicy, "siteKey" | "platform"> &
  Partial<Omit<DtcSitePolicy, "siteKey" | "platform" | "kind" | "catalogUrl" | "brands">> &
  (
    | { kind?: "single-brand"; catalogUrl: string | null; brands?: never }
    | { kind: "multi-brand"; brands: readonly DtcBrandCatalog[]; catalogUrl?: never }
  );

export const DTC_PAGE_LIMITS = { maxBytes: 6 * 1024 * 1024, timeoutMs: 75_000 };
export const DTC_BROWSER_POLICY = {
  readySelector: "main, #MainContent, .site-main",
  preparationScript: dtcPreparationScript(),
};

const catalog = {
  catalogSelector: [
    "#product-grid",
    ".collection .grid",
    "ul.products",
    "[data-product-grid]",
    ".product-sec .prod-row",
    ".product-list--collection",
  ].join(", "),
  productLinkSelector:
    'a[href*="/products/"]:not(.trust-score-badge), a.woocommerce-LoopProduct-link',
  nextSelector:
    'a[rel="next"], .pagination a.next, a.next.page-numbers, .pagination a[aria-label="Next page" i]',
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

const STORE_PRODUCT_PATH = /^\/(?:collections\/[^/]+\/)?products?\/[^/]+\/?$/;
/**
 * Owner 2026-10-08: a custom-built store (JSON-LD platform) names product pages freely (PureTrim: /cardio9.cfm,
 * /starterpaks/30-day-cleanse.cfm). Any non-root path on the site may be a product; the catalog evidence and the
 * product page's own JSON-LD Product still decide.
 */
const CUSTOM_PRODUCT_PATH = /^\/[^/?#][^?#]*$/;

/** An unverified site is addressable, but reading waits for its browser-checked policy. */
export function dtcSitePolicy(site: SiteInput): DtcSitePolicy {
  const origins = site.origins ?? [`https://${site.siteKey}`];
  const listing = site.catalog ?? catalog;
  return {
    kind: "single-brand",
    catalogUrl: null,
    brands: [],
    origins,
    imageOrigins: [...origins, "https://cdn.shopify.com"],
    productPath: site.platform === "jsonld" ? CUSTOM_PRODUCT_PATH : STORE_PRODUCT_PATH,
    ...site,
    catalog: listing,
    scroll: site.scroll ?? { ...scroll, itemSelector: catalogItemSelector(listing) },
  };
}

/** Private configured sites; API-discovered sources are loaded from their persisted policies. */
export const DTC_SITES: readonly DtcSitePolicy[] = [];
