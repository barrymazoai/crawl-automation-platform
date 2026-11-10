import { brandScanErrors } from "@crawl-automation/channels-core";
import { AMAZON_US, type AmazonSite } from "./site.js";

export const AMAZON_SCAN_MAX_PAGES = 7;
const BRAND_FILTER = /^(?:p_123:\d+|p_(?:4|89):[^,|]{1,80})$/;

function filtersOf(url: URL): string[] {
  const filters = (url.searchParams.get("rh") ?? "").split(",");
  const brands = filters.filter((filter) => BRAND_FILTER.test(filter));
  if (
    brands.length !== 1 ||
    filters.some((filter) => !BRAND_FILTER.test(filter) && !/^n:\d+$/.test(filter))
  ) {
    throw brandScanErrors.create("BRAND_SCAN.URL");
  }
  return filters;
}

function checkBrandPage(url: URL): void {
  const node = url.searchParams.get("srs");
  if (node === null) {
    return;
  }
  const filters = filtersOf(url);
  if (
    !/^\d{1,20}$/.test(node) ||
    filters.length !== 1 ||
    !filters[0]?.startsWith("p_89:") ||
    url.searchParams.has("k") ||
    url.searchParams.has("i")
  ) {
    throw brandScanErrors.create("BRAND_SCAN.URL");
  }
}

/** Only observed Brand-filter searches and /s?srs= brand pages; Store URLs need a browser. */
export function amazonScanSourceUrl(raw: string, site: AmazonSite = AMAZON_US): string {
  const url = URL.parse(raw, site.origin);
  if (!url || url.origin !== site.origin || url.username || url.password || url.pathname !== "/s") {
    throw brandScanErrors.create("BRAND_SCAN.URL");
  }
  filtersOf(url);
  checkBrandPage(url);
  const result = new URL("/s", site.origin);
  for (const key of ["k", "i", "srs", "rh", "dc"]) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      result.searchParams.set(key, value);
    }
  }
  result.searchParams.set("s", site.scanSort);
  return result.href;
}

export function amazonScanPageUrl(
  source: string,
  page: number,
  site: AmazonSite = AMAZON_US,
): string {
  if (!Number.isInteger(page) || page < 1 || page > AMAZON_SCAN_MAX_PAGES) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { details: { page } });
  }
  const url = new URL(amazonScanSourceUrl(source, site));
  url.searchParams.set("page", String(page));
  return url.href;
}

/** The shared numeric brand ID, or null for other supported brand filter types. */
export function amazonBrandFilterId(url: string, site: AmazonSite = AMAZON_US): string | null {
  return /^p_123:(\d{1,12})$/.exec(amazonScanBrandFilter(url, site))?.[1] ?? null;
}

export function amazonScanBrandFilter(url: string, site: AmazonSite = AMAZON_US): string {
  return (
    filtersOf(new URL(amazonScanSourceUrl(url, site))).find((filter) =>
      BRAND_FILTER.test(filter),
    ) ?? ""
  );
}

/** The observed retail brand keyword, never a fallback to a holding-company record. */
export function amazonBrandSearchName(url: string, site: AmazonSite = AMAZON_US): string | null {
  return new URL(amazonScanSourceUrl(url, site)).searchParams.get("k")?.trim() || null;
}

/**
 * KAN-243 (owner 2026-11-08): the same brand's search on another storefront. Amazon's numeric brand IDs (`p_123`) are
 * shared across storefronts (Himalaya is 94291 on amazon.com and amazon.in), so a source with one ID and its search
 * keyword becomes that storefront's supplement-scoped brand search; null without both.
 */
export function amazonBrandSearchOn(url: string, from: AmazonSite, to: AmazonSite): string | null {
  const id = amazonBrandFilterId(url, from);
  const name = amazonBrandSearchName(url, from);
  return id && name ? amazonBrandSearch(name, id, to) : null;
}

/** A storefront's supplement-scoped search for one numeric brand ID, as a brand scan source. */
export function amazonBrandSearch(name: string, id: string, site: AmazonSite): string {
  const result = new URL("/s", site.origin);
  result.searchParams.set("k", name);
  result.searchParams.set("i", site.searchAlias);
  result.searchParams.set("rh", `n:${site.supplementNode},p_123:${id}`);
  return amazonScanSourceUrl(result.href, site);
}
