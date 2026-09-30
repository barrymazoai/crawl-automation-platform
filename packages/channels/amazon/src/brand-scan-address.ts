import { brandScanErrors } from "@crawl-automation/channels-core";
import { AMAZON_ORIGIN } from "./address.js";

export const AMAZON_SCAN_MAX_PAGES = 7;
const SORT = "date-desc-rank";
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
export function amazonScanSourceUrl(raw: string): string {
  const url = URL.parse(raw, AMAZON_ORIGIN);
  if (
    !url ||
    url.origin !== AMAZON_ORIGIN ||
    url.username ||
    url.password ||
    url.pathname !== "/s"
  ) {
    throw brandScanErrors.create("BRAND_SCAN.URL");
  }
  filtersOf(url);
  checkBrandPage(url);
  const result = new URL("/s", AMAZON_ORIGIN);
  for (const key of ["k", "i", "srs", "rh", "dc"]) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      result.searchParams.set(key, value);
    }
  }
  result.searchParams.set("s", SORT);
  return result.href;
}

export function amazonScanPageUrl(source: string, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > AMAZON_SCAN_MAX_PAGES) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { details: { page } });
  }
  const url = new URL(amazonScanSourceUrl(source));
  url.searchParams.set("page", String(page));
  return url.href;
}

/** The shared numeric brand ID, or null for other supported brand filter types. */
export function amazonBrandFilterId(url: string): string | null {
  return /^p_123:(\d{1,12})$/.exec(amazonScanBrandFilter(url))?.[1] ?? null;
}

export function amazonScanBrandFilter(url: string): string {
  return (
    filtersOf(new URL(amazonScanSourceUrl(url))).find((filter) => BRAND_FILTER.test(filter)) ?? ""
  );
}
