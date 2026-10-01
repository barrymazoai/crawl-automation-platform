import type { PurchaseConditions } from "@crawl-automation/v3-contracts";
import { commerceElements, uniqueCommerce } from "./commerce-dom.js";
import type { AmazonElement } from "./dom.js";
import { commerceVisibleText as textOf } from "./commerce-dom.js";

const SELECTORS = [
  "#couponsInBuybox_feature_div",
  "#coupons_feature_div",
  "#promoPriceBlockMessage_feature_div",
  "#promotionMessageInsideBuyBox_feature_div",
  "#corePriceDisplay_desktop_feature_div",
];

function promotionType(text: string, selector: string) {
  if (/coupon/i.test(text + selector)) {
    return "coupon" as const;
  }
  if (/\bbuy\s+\d|\b(?:spend|orders? over|minimum)\b/i.test(text)) {
    return "multibuy" as const;
  }
  return /prime|member/i.test(text) ? ("membership" as const) : ("discount" as const);
}

function promotion(text: string, selector: string): PurchaseConditions["promotions"][number] {
  return {
    type: promotionType(text, selector),
    description: text.slice(0, 4000),
    amount: uniqueCommerce(
      [...text.matchAll(/(?:save\s+|coupon\s*:?\s*)(?:US\$|\$)\s*(\d+(?:\.\d+)?)/gi)].map(
        (match) => match[1],
      ),
    ),
    percent: uniqueCommerce(
      [...text.matchAll(/(?:save\s+|-)(\d+(?:\.\d+)?)\s*%/gi)].map((match) => match[1]),
    ),
    currency: null,
    conditionsText: text.slice(0, 4000),
    // A checked coupon alone is not an applied discount.
    applied: /\bcoupon applied\b|\bdiscount applied\b/i.test(text) ? true : null,
  };
}

export function purchasePromotions(input: {
  root: AmazonElement;
  offer: AmazonElement | null;
  out: PurchaseConditions;
}): void {
  const { root, offer, out } = input;
  for (const selector of SELECTORS) {
    for (const element of commerceElements(root, selector)) {
      const row = element.closest("#buyBoxAccordion .a-box");
      const text = textOf(element);
      if (
        (row && row !== offer) ||
        !/coupon|save|saving|discount|%|buy\s+\d|get\s+\d/i.test(text)
      ) {
        continue;
      }
      if (
        out.promotions.length >= 30 ||
        out.promotions.some((item) => item.description === text.slice(0, 4000))
      ) {
        continue;
      }
      out.promotions.push(promotion(text, selector));
      out.evidence.push({ field: "promotions", selector, text: text.slice(0, 4000) });
      for (const box of commerceElements(element, 'input[type="checkbox"]')) {
        out.evidence.push({
          field: "couponSelection",
          selector,
          text: `checked=${box.hasAttribute("checked")}`,
        });
      }
    }
  }
}
