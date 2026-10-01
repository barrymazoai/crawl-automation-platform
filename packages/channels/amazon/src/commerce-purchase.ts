import type { PurchaseConditions } from "@crawl-automation/v3-contracts";
import {
  commerceElements,
  commerceText,
  locationText,
  selectedOffer,
  uniqueCommerce,
} from "./commerce-dom.js";
import { amount, priceText } from "./commerce-prices.js";
import { purchasePromotions } from "./commerce-promotions.js";
import { purchaseOptions } from "./commerce-options.js";
import { purchaseSeller } from "./commerce-seller.js";
import type { AmazonElement } from "./dom.js";
import { commerceVisibleText as textOf } from "./commerce-dom.js";

function initialConditions(root: AmazonElement, price: string | null): PurchaseConditions {
  const text = locationText(root);
  return {
    codec: "purchase-conditions/1",
    purchaseType: "unknown",
    seller: { name: null, id: null, url: null },
    shipsFrom: null,
    delivery: {
      countryCode: null,
      postalCode: uniqueCommerce(text?.match(/\b\d{5}(?:-\d{4})?\b/g) ?? []),
      text,
    },
    selectedOptions: [],
    quantity: null,
    subscription: null,
    promotions: [],
    priceScope: price ? "page_display" : "unknown",
    evidence: [],
    warnings: [],
  };
}

function nativePurchase(offer: AmazonElement): boolean {
  const forms = commerceElements(offer, "form#addToCart");
  const form = forms.length === 1 ? forms[0] : null;
  if (!form) {
    return false;
  }
  return [
    ["add-to-cart-button", "submit.add-to-cart", "/cart/add-to-cart"],
    ["buy-now-button", "submit.buy-now", "/checkout/entry/buynow"],
  ].every(([id, name, path]) => {
    const buttons = commerceElements(form, `input#${id}[name="${name}"]`);
    const button = buttons.length === 1 ? buttons[0] : null;
    const url = URL.parse(button?.getAttribute("formaction") ?? "", "https://www.amazon.com");
    return (
      button &&
      !button.hasAttribute("disabled") &&
      url?.origin === "https://www.amazon.com" &&
      (url.pathname === path || url.pathname.startsWith(`${path}/`))
    );
  });
}

function offerConditions(
  input: { root: AmazonElement; offer: AmazonElement; price: string | null },
  out: PurchaseConditions,
): void {
  const { offer } = input;
  const text = textOf(offer);
  const heading = commerceText(offer, ".accordion-caption") ?? text;
  out.evidence.push({
    field: "selectedOffer",
    selector: "#buybox, #buyBoxAccordion .a-accordion-active",
    text: text.slice(0, 4000),
  });
  if (/^One[-\s]time purchase\b/i.test(heading)) {
    out.purchaseType = "one_time";
  } else if (/^Subscribe\s*&\s*Save\b/i.test(heading)) {
    out.purchaseType = "subscription";
  }
  offerBinding(input, out);
  purchaseSeller(offer, out);
  offerQuantity(offer, out);
}

function offerBinding(
  input: { root: AmazonElement; offer: AmazonElement; price: string | null },
  out: PurchaseConditions,
): void {
  const { root, offer, price } = input;
  const text = textOf(offer);
  const quoted = uniqueCommerce(
    commerceElements(
      offer,
      "#corePrice_feature_div .apex-pricetopay-value, #corePrice_feature_div .priceToPay",
    ).map((element) => amount(priceText(element))),
  );
  if (price && quoted === price) {
    out.priceScope = "selected_offer";
  } else {
    out.warnings.push("PURCHASE.PRICE_BINDING_UNKNOWN");
  }
  if (
    out.purchaseType === "unknown" &&
    out.priceScope === "selected_offer" &&
    !commerceElements(root, "#buyBoxAccordion").length &&
    !/subscribe|subscription/i.test(text) &&
    nativePurchase(offer)
  ) {
    out.purchaseType = "one_time";
  }
}

function offerQuantity(offer: AmazonElement, out: PurchaseConditions): void {
  const text = textOf(offer);
  const quantity = uniqueCommerce(
    commerceElements(offer, 'select[name="quantity"], select#quantity').map((select) =>
      select.querySelector("option[selected]")?.getAttribute("value"),
    ),
  );
  out.quantity =
    quantity && /^\d+$/.test(quantity) && Number(quantity) > 0 && Number(quantity) <= 10000
      ? Number(quantity)
      : null;
  if (out.purchaseType === "subscription") {
    out.subscription = {
      frequencyText: commerceText(
        offer,
        'select[name*="frequency"] option[selected], select[id*="frequency"] option[selected], #sns-frequency',
      ),
      conditionsText: text.slice(0, 4000) || null,
    };
  }
}

export function purchaseConditions(root: AmazonElement, price: string | null): PurchaseConditions {
  const out = initialConditions(root, price);
  const offer = selectedOffer(root);
  if (out.delivery.text) {
    out.evidence.push({
      field: "delivery",
      selector: "#nav-global-location-popover-link",
      text: out.delivery.text,
    });
  }
  if (offer && textOf(offer)) {
    offerConditions({ root, offer, price }, out);
  } else {
    out.warnings.push("PURCHASE.OFFER_SELECTION_UNKNOWN");
  }
  purchaseOptions(root, out);
  purchasePromotions({ root, offer, out });
  if (!out.promotions.length) {
    out.warnings.push("PURCHASE.PROMOTIONS_NOT_OBSERVED");
  }
  if (!out.seller.name) {
    out.warnings.push("PURCHASE.SELLER_UNKNOWN");
  }
  if (!out.quantity) {
    out.warnings.push("PURCHASE.QUANTITY_NOT_OBSERVED");
  }
  if (out.purchaseType === "unknown") {
    out.warnings.push("PURCHASE.TYPE_UNKNOWN");
  }
  out.evidence = out.evidence.slice(0, 60);
  out.warnings = [...new Set(out.warnings)].slice(0, 30);
  return out;
}
