import { brandScanErrors, type ListedProduct } from "@crawl-automation/channels-core";
import { AMAZON_ORIGIN, isAsin } from "./address.js";
import { textOf, type AmazonElement } from "./dom.js";

const ADVERTISEMENT = [
  '[data-component-type="s-sponsored-label-marker"]',
  ".puis-sponsored-label-text",
  '[class*="AdHolder"]',
  '[class*="ad-feedback"]',
  '[id*="ad-feedback"]',
  'a[href*="ad-feedback"]',
  'a[href*="/sspa/click"]',
  'a[href*="sponsored-ads.amazon.com"]',
].join(",");

function isAdvertisement(card: AmazonElement): boolean {
  return (
    card.matches(ADVERTISEMENT) ||
    !!card.querySelector(ADVERTISEMENT) ||
    /\bSponsored\b/i.test(textOf(card))
  );
}

/** Direct result cards only: nested carousels and recommendations are not the brand's listing. */
export function amazonOrganicCards(grid: AmazonElement): AmazonElement[] {
  return [...grid.children].filter(
    (card) =>
      card.matches('div[data-component-type="s-search-result"][data-asin]') &&
      !!card.getAttribute("data-asin") &&
      !isAdvertisement(card),
  );
}

export function amazonCardProduct(card: AmazonElement): ListedProduct {
  const listingId = card.getAttribute("data-asin") ?? "";
  if (!isAsin(listingId)) {
    throw brandScanErrors.create("BRAND_SCAN.TILE_IDENTITY");
  }
  const heading =
    card.querySelector('a[href*="/dp/"] h2, h2 a[href*="/dp/"]') ??
    card.querySelector("h2[aria-label], h2");
  return {
    listingId,
    url: `${AMAZON_ORIGIN}/dp/${listingId}`,
    variantId: null,
    title: textOf(heading).slice(0, 500) || null,
    kind: "product",
  };
}
