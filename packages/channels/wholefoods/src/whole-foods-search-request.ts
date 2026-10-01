import type { ListingPolicyRequest } from "@crawl-automation/channels-core";
import { WHOLE_FOODS_ORIGIN } from "./whole-foods-address.js";
import type { WholeFoodsHttpScanSettings } from "./whole-foods-http-settings.js";
import { wholeFoodsStoreCookie } from "./whole-foods-store.js";

export interface WholeFoodsSearchTarget {
  sourceUrl: string;
  read: string;
  page: number;
  attempt: number;
}

export function wholeFoodsSearchUrl(
  source: string,
  page: number,
  settings: WholeFoodsHttpScanSettings,
): string {
  const url = new URL(source);
  const query = new URLSearchParams({
    text: url.searchParams.get("k") ?? "",
    old: settings.store.offerListingDiscriminator,
    sort: "relevanceblender",
    programType: "GROCERY",
    categories: settings.store.categoryId,
    offset: String((page - 1) * settings.size),
    size: String(settings.size),
  });
  const filter = url.searchParams.get("rh");
  if (filter) {
    query.set("filters", filter);
  }
  return `${WHOLE_FOODS_ORIGIN}/api/wwos/rsi/search?${query}`;
}

/** A unique label for every allowed try makes reattachment reuse precisely that observation. */
export function wholeFoodsSearchRequest(
  target: WholeFoodsSearchTarget,
  settings: WholeFoodsHttpScanSettings,
): ListingPolicyRequest {
  return {
    url: wholeFoodsSearchUrl(target.sourceUrl, target.page, settings),
    label: `${target.read}-page-${target.page}-attempt-${target.attempt}`,
    answer: "json",
    maxBytes: 8 * 1024 * 1024,
    options: {
      render: false,
      premium: false,
      sessionNumber: null,
      headers: {
        cookie: wholeFoodsStoreCookie(settings.store),
        "content-type": "application/json",
        accept: "*/*",
      },
    },
  };
}
