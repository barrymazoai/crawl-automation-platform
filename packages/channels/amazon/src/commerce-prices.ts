import type { CommerceEvidence } from "@crawl-automation/channels-core";
import { commerceElements, commerceVisibleText, selectedOffer } from "./commerce-dom.js";
import { cleanText, textOf, type AmazonElement } from "./dom.js";

const SUBSCRIPTION = '#subscriptionPrice, [id*="sns"], [id*="subscribe"]';
const digits = (element: AmazonElement, selector: string) =>
  cleanText(element.querySelector(selector)?.textContent ?? "");

/** Price digits may be aria-hidden: their accessible counterpart states the same amount. */
export function priceText(element: AmazonElement): string {
  const offscreen = digits(element, ".a-offscreen");
  if (offscreen) {
    return offscreen;
  }
  const symbol = digits(element, ".a-price-symbol");
  const whole = digits(element, ".a-price-whole");
  const fraction = digits(element, ".a-price-fraction");
  return whole ? `${symbol}${whole.replace(/[.\s]/g, "")}.${fraction || "00"}` : textOf(element);
}

export function amount(raw: string | undefined): string | null {
  return raw?.match(/(?:\$|USD\s*)\s*([\d,]+(?:\.\d{1,2})?)/)?.[1]?.replaceAll(",", "") ?? null;
}

function candidates(root: AmazonElement, selector: string): string[] {
  return [...new Set(commerceElements(root, selector).map(priceText).filter(Boolean))];
}

/** Conflicting main amounts remain unknown; inactive offers never fill missing prices. */
export function priceCandidates(root: AmazonElement): string[] {
  const main = candidates(root, "#corePriceDisplay_desktop_feature_div .priceToPay");
  if (main.length > 0) {
    return main;
  }
  const offer = selectedOffer(root);
  const selected = offer
    ? candidates(
        offer,
        "#corePrice_feature_div .apex-pricetopay-value, #corePrice_feature_div .priceToPay",
      )
    : [];
  if (selected.length > 0) {
    return selected;
  }
  const fallback = commerceElements(
    root,
    "#corePrice_feature_div .a-price:not(.a-text-price), #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox",
  ).filter(
    (element) =>
      !element.closest(SUBSCRIPTION) &&
      (!element.closest("#buyBoxAccordion") || offer?.contains(element)),
  );
  return [...new Set(fallback.map(priceText).filter(Boolean))];
}

export function priceStatus(input: {
  prices: string[];
  availability: string | null;
  root: AmazonElement;
}): CommerceEvidence["priceStatus"] {
  const { prices, availability, root } = input;
  if (prices.length === 1 && amount(prices[0])) {
    return "observed";
  }
  if (/unavailable|out of stock/i.test(availability ?? "")) {
    return "unavailable";
  }
  const offer = commerceElements(root, "#buybox").map(commerceVisibleText).join(" ");
  if (/See All Buying Options/i.test(offer)) {
    return "buying_options";
  }
  if (/To see product details, add this item to your cart|See price in cart/i.test(offer)) {
    return "cart_required";
  }
  return prices.length > 1 ? "ambiguous" : "not_observed";
}
