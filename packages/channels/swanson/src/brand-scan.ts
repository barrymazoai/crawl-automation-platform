import { brandScanErrors, type BrandScanReader } from "@crawl-automation/channels-core";
import { SWANSON_ORIGIN } from "./swanson-address.js";
import { resolveSwansonBrand } from "./brand-resolution.js";
import type { SwansonBrandScanSettings } from "./brand-scan-settings.js";
import {
  CONSTRUCTOR_ORIGIN,
  CONSTRUCTOR_MAX_PAGES,
  CONSTRUCTOR_PAGE_SIZE,
  constructorComplete,
  parseConstructorPage,
} from "./constructor-page.js";

const SLUG = /^\/collections\/brand-([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/products\.json)?\/?$/;

function sourceUrl(raw: string): string {
  const url = URL.parse(raw, SWANSON_ORIGIN);
  const slug = url?.pathname.match(SLUG)?.[1];
  const ownSite = url && [SWANSON_ORIGIN, "https://swansonvitamins.com"].includes(url.origin);
  if (!ownSite || url.username || url.password || !slug) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { details: { url: raw } });
  }
  return `${SWANSON_ORIGIN}/collections/brand-${slug}`;
}

function pageUrl(source: string, page: number): string {
  const url = URL.parse(source);
  if (
    !url ||
    url.origin !== CONSTRUCTOR_ORIGIN ||
    !url.pathname.startsWith("/browse/brand/") ||
    url.username ||
    url.password ||
    url.hash ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > CONSTRUCTOR_MAX_PAGES
  ) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { details: { page } });
  }
  url.searchParams.set("page", String(page));
  url.searchParams.set("num_results_per_page", String(CONSTRUCTOR_PAGE_SIZE));
  return url.href;
}

/** Resolve the stored name or collection title, then read archived Constructor JSON pages. */
export function createSwansonBrandScan(settings?: SwansonBrandScanSettings): BrandScanReader {
  return {
    sourceUrl,
    resolve: (source) => resolveSwansonBrand({ ...source, url: sourceUrl(source.url) }, settings),
    origins: [SWANSON_ORIGIN, CONSTRUCTOR_ORIGIN],
    pageUrl,
    answer: "json",
    maxPages: CONSTRUCTOR_MAX_PAGES,
    maxBytes: 8 * 1024 * 1024,
    parsePage: parseConstructorPage,
    complete: constructorComplete,
  };
}

export const swansonBrandScan = createSwansonBrandScan();
