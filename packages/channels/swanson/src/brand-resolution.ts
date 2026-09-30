import type { ListingResolveRequest } from "@crawl-automation/channels-core";
import type { SwansonBrandScanSettings } from "./brand-scan-settings.js";
import { swansonCollectionTitle } from "./collection-page.js";
import {
  CONSTRUCTOR_ORIGIN,
  CONSTRUCTOR_PAGE_SIZE,
  parseConstructorPage,
} from "./constructor-page.js";
import { swansonErrors } from "./swanson-errors.js";

function brandUrl(brandName: string, key: string): string {
  const url = new URL(`/browse/brand/${encodeURIComponent(brandName)}`, CONSTRUCTOR_ORIGIN);
  url.searchParams.set("key", key);
  url.searchParams.set("page", "1");
  url.searchParams.set("num_results_per_page", String(CONSTRUCTOR_PAGE_SIZE));
  return url.href;
}

function collectionRequest(url: string, key: string): ListingResolveRequest {
  return {
    request: { url, label: "resolve", answer: "html", maxBytes: 6 * 1024 * 1024 },
    parsePage: ({ body }) => {
      const brandName = swansonCollectionTitle(body);
      return {
        sourceUrl: brandUrl(brandName, key),
        nameResolution: { brandName, usedFallback: true },
      };
    },
  };
}

/** Try the stored name once; only an explicit zero total needs the collection's exact title. */
export function resolveSwansonBrand(
  source: { url: string; brandName?: string | undefined },
  settings?: SwansonBrandScanSettings,
): ListingResolveRequest {
  if (!settings?.constructorKey) {
    throw swansonErrors.create("SWANSON.CONSTRUCTOR_KEY_MISSING");
  }
  const key = settings.constructorKey;
  const fallback = () => collectionRequest(source.url, key);
  const brandName = source.brandName;
  if (!brandName?.trim()) {
    return fallback();
  }
  const url = brandUrl(brandName, key);
  return {
    request: { url, label: "resolve-name", answer: "json", maxBytes: 8 * 1024 * 1024 },
    parsePage: (page) => {
      const firstPage = parseConstructorPage({ ...page, page: 1 });
      return firstPage.statedTotal === 0
        ? fallback()
        : { sourceUrl: url, firstPage, nameResolution: { brandName, usedFallback: false } };
    },
  };
}
