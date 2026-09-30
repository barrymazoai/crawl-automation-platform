import { brandScanErrors } from "@crawl-automation/channels-core";
import { AMAZON_ORIGIN } from "./address.js";

const PAGE = /^\/stores\/(?:([^/]+)\/)?page\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/?$/i;

/** Store page IDs are stable across slug aliases and tracking URLs. */
export function amazonStoreAddress(raw: string) {
  const url = URL.parse(raw, AMAZON_ORIGIN);
  const match = url?.pathname.match(PAGE);
  if (!url || url.origin !== AMAZON_ORIGIN || url.username || url.password || !match?.[2]) {
    throw brandScanErrors.create("BRAND_SCAN.URL");
  }
  const pageId = match[2].toUpperCase();
  return {
    url: `${AMAZON_ORIGIN}/stores/page/${pageId}`,
    pageId,
    storeKey: match[1]?.toLowerCase() ?? null,
  };
}

export const amazonStoreSourceUrl = (raw: string): string => amazonStoreAddress(raw).url;

/** Anonymous page links are allowed only when observed in the Store's own navigation. */
export function amazonStoreNavigation(raw: string, storeKey: string | null): string | null {
  const url = URL.parse(raw, AMAZON_ORIGIN);
  if (!url || url.origin !== AMAZON_ORIGIN || !PAGE.test(url.pathname)) {
    return null;
  }
  const address = amazonStoreAddress(raw);
  return storeKey && address.storeKey && storeKey !== address.storeKey ? null : address.url;
}
