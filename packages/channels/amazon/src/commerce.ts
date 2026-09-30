import type { CommerceEvidence } from "@crawl-automation/channels-core";
import { cleanText, hidden, textOf, type AmazonElement } from "./dom.js";

const PRICE_SELECTORS = [
  "#corePriceDisplay_desktop_feature_div .priceToPay",
  "#corePrice_feature_div .a-price:not(.a-text-price)",
  "#priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox",
];
const SUBSCRIPTION = '#subscriptionPrice, [id*="sns"], [id*="subscribe"]';
const oneTimeOffer = (element: AmazonElement) => !hidden(element) && !element.closest(SUBSCRIPTION);

const digits = (element: AmazonElement, selector: string) =>
  cleanText(element.querySelector(selector)?.textContent ?? "");

/**
 * Price digits are aria-hidden because the same number is often repeated in an accessible label.
 */
function priceText(element: AmazonElement): string {
  const offscreen = digits(element, ".a-offscreen");
  if (offscreen) {
    return offscreen;
  }
  const symbol = digits(element, ".a-price-symbol");
  const whole = digits(element, ".a-price-whole");
  const fraction = digits(element, ".a-price-fraction");
  return whole ? `${symbol}${whole.replace(/[.\s]/g, "")}.${fraction || "00"}` : textOf(element);
}

function priceCandidates(root: AmazonElement): string[] {
  for (const selector of PRICE_SELECTORS) {
    const values = [...root.querySelectorAll(selector)]
      .filter(oneTimeOffer)
      .map(priceText)
      .filter(Boolean);
    if (values.length) {
      return [...new Set(values)];
    }
  }
  return [];
}

function amount(raw: string | undefined): string | null {
  return raw?.match(/(?:\$|USD\s*)\s*([\d,]+(?:\.\d{1,2})?)/)?.[1]?.replaceAll(",", "") ?? null;
}

function rating(root: AmazonElement): string | null {
  const section = root.querySelector("#averageCustomerReviews");
  const popover = section?.querySelector("#acrPopover") ?? root.querySelector("#acrPopover");
  const raw = popover?.getAttribute("title") ?? textOf(section ?? popover);
  return raw.match(/([0-5](?:\.\d+)?)\s+out of 5 stars/i)?.[1] ?? null;
}

function reviewCount(root: AmazonElement): string | null {
  const count = root.querySelector("#averageCustomerReviews #acrCustomerReviewText");
  const raw = count?.getAttribute("aria-label") ?? textOf(count);
  return raw.match(/[\d,]+/)?.[0]?.replaceAll(",", "") ?? null;
}

function priceStatus(
  prices: string[],
  availability: string | null,
): CommerceEvidence["priceStatus"] {
  if (prices.length > 1) {
    return "ambiguous";
  }
  if (amount(prices[0])) {
    return "observed";
  }
  return /unavailable|out of stock/i.test(availability ?? "") ? "unavailable" : "not_observed";
}

/**
 * Metrics of the selected product; related products and subscription prices cannot fill missing
 * values.
 */
export function amazonCommerce(root: AmazonElement, asin: string): CommerceEvidence {
  const prices = priceCandidates(root);
  const price = prices.length === 1 ? amount(prices[0]) : null;
  const availability =
    [...root.querySelectorAll("#availability")]
      .filter((element) => !hidden(element))
      .map(textOf)
      .find(Boolean) ?? null;
  const list = [
    ...root.querySelectorAll('#corePriceDisplay_desktop_feature_div [data-a-strike="true"]'),
  ].find(oneTimeOffer);
  return {
    codec: "public-product-commerce/1",
    sku: asin,
    price,
    currency: price ? "USD" : null,
    listPrice: list ? amount(priceText(list)) : null,
    rating: rating(root),
    reviewCount: reviewCount(root),
    availability,
    context: [],
    priceStatus: priceStatus(prices, availability),
  };
}
