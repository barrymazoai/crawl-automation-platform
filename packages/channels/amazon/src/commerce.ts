import type { CommerceEvidence } from "@crawl-automation/channels-core";
import type { AmazonElement } from "./dom.js";
import { commerceVisibleText as textOf } from "./commerce-dom.js";
import { commerceElements, commerceText, locationText, selectedOffer } from "./commerce-dom.js";
import { amount, otherOffer, priceCandidates, priceStatus, priceText } from "./commerce-prices.js";
import { purchaseConditions } from "./commerce-purchase.js";
import { salesVolume } from "./commerce-sales.js";
import { amazonListingDate } from "./listing-date.js";
import { amazonSalesRank } from "./sales-rank.js";
import { AMAZON_US, type AmazonSite } from "./site.js";

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

function contextOf(root: AmazonElement): string[] {
  const location = locationText(root);
  const offer = selectedOffer(root);
  return [
    ...(location ? [location] : []),
    ...commerceElements(root, "#corePriceDisplay_desktop_feature_div").map(
      (element) => `main offer: ${textOf(element).slice(0, 1200)}`,
    ),
    ...(offer ? [`selected offer: ${textOf(offer).slice(0, 2500)}`] : []),
  ].slice(0, 20);
}

/**
 * Metrics of the selected product; related products and subscription prices cannot fill missing
 * values.
 */
export function amazonCommerce(
  root: AmazonElement,
  asin: string,
  site: AmazonSite = AMAZON_US,
): CommerceEvidence {
  const prices = priceCandidates(root);
  const pickup = otherOffer(root, site);
  const price = !pickup && prices.length === 1 ? amount(prices[0], site) : null;
  const availability = commerceText(root, "#availability")?.slice(0, 1000) ?? null;
  const lists = commerceElements(
    root,
    '#corePriceDisplay_desktop_feature_div [data-a-strike="true"], #corePriceDisplay_desktop_feature_div .apex-basisprice-value, #corePriceDisplay_desktop_feature_div .basisPrice .a-text-price',
  );
  const listPrices = [
    ...new Set(lists.map((element) => amount(priceText(element), site)).filter(Boolean)),
  ];
  return {
    codec: "public-product-commerce/1",
    sku: asin,
    price,
    currency: price ? site.currency : null,
    listPrice: listPrices.length === 1 ? (listPrices[0] ?? null) : null,
    rating: rating(root),
    reviewCount: reviewCount(root),
    availability,
    context: contextOf(root),
    priceStatus: priceStatus({ prices, availability, root, otherOffer: !!pickup, site }),
    ...(pickup ? { otherOffer: pickup } : {}),
    salesVolume: salesVolume(root),
    purchaseConditions: purchaseConditions(root, price, site),
    dateFirstAvailable: amazonListingDate(root.ownerDocument, site),
    salesRank: amazonSalesRank(root.ownerDocument),
  };
}
