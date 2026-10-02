import { schemaCommerce } from "@crawl-automation/channels-core";
import type { CommerceOwner, StockSignal } from "./swanson-commerce-data.js";
import { SWANSON_RECOMMENDATIONS, swansonProductElements } from "./swanson-shopify-selection.js";

const UNAVAILABLE_NOTICE = new RegExp(
  "^(?:we're sorry,?\\s*(?:but\\s*)?)?(?:this (?:item|product) is )?(?:currently )?" +
    "(?:sold out|out of stock|unavailable)(?:[.!]| due to a manufacturer stock issue[.!]?)?$",
  "i",
);

function optionAvailability(input: Element): unknown {
  const flag = input.getAttribute("data-option-available");
  return flag === "true" ? true : flag === "false" ? false : flag;
}

/** Hidden and recommended content cannot describe this product's visible stock state. */
export function swansonCommerceRoot(document: Document, owner: CommerceOwner): Element | null {
  const detail = swansonProductElements(document, "main [data-cnstrc-product-detail]").find(
    (element) =>
      element.getAttribute("data-product-id") === owner.productId &&
      element.getAttribute("data-variant-id") === owner.variantId,
  );
  const root = detail ?? document.querySelector("main");
  const copy = root?.cloneNode(true) as Element | undefined;
  for (const element of copy?.querySelectorAll(SWANSON_RECOMMENDATIONS) ?? []) {
    element.remove();
  }
  return copy ?? null;
}

function visibleStock(root: Element): StockSignal[] {
  const copy = root.cloneNode(true) as Element;
  for (const element of copy.querySelectorAll(
    "script, style, details, [hidden], [aria-hidden=true], .hidden, .sr-only",
  )) {
    element.remove();
  }
  for (const element of copy.querySelectorAll("[style]")) {
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(element.getAttribute("style") ?? "")) {
      element.remove();
    }
  }
  return [...copy.querySelectorAll("div, p, span, button")]
    .filter((element) => element.children.length === 0)
    .flatMap((element) => {
      const text = (element.textContent ?? "").trim().replace(/\s+/g, " ");
      const notify = /^notify me$/i.test(text) && element.closest(".cordial-bis-form");
      if (UNAVAILABLE_NOTICE.test(text) || notify) {
        return [{ source: `product text: ${text}`, value: false }];
      }
      return /^in stock[.!]?$/i.test(text)
        ? [{ source: `product text: ${text}`, value: true }]
        : [];
    });
}

export function swansonDomStock(root: Element | null, owner: CommerceOwner): StockSignal[] {
  if (!root) {
    return [];
  }
  const options = [...root.querySelectorAll("variant-picker input[data-variant-id]")]
    .filter(
      (input) => input.hasAttribute("checked") || input.getAttribute("aria-checked") === "true",
    )
    .filter((input) => input.getAttribute("data-variant-id") === owner.variantId)
    .filter(
      (input) =>
        input.closest("variant-picker")?.getAttribute("data-product-id") === owner.productId,
    )
    .map((input) => ({
      source: "selected option",
      value: optionAvailability(input),
    }));
  const microdata = [...root.querySelectorAll('[itemprop="availability"]')].map((element) => ({
    source: "product availability microdata",
    value: element.getAttribute("content") || element.getAttribute("href") || element.textContent,
  }));
  return [...options, ...microdata, ...visibleStock(root)];
}

function stockValue(value: unknown): "available" | "unavailable" | null {
  const state = schemaCommerce({ availability: value }).availability;
  if (state === "InStock" || state === "available") {
    return "available";
  }
  if (state === "OutOfStock" || state === "unavailable") {
    return "unavailable";
  }
  return null;
}

/** Use Whole Foods' commerce vocabulary; disagreement never becomes an availability guess. */
export function swansonStock(signals: StockSignal[]) {
  const present = signals.filter((signal) => signal.value !== null && signal.value !== undefined);
  const values = present.map((signal) => stockValue(signal.value));
  const states = new Set(values);
  if (states.size === 1 && !states.has(null)) {
    return { availability: values[0] ?? null, reasons: [] };
  }
  const reason =
    present.length === 0
      ? "no product-owned signal observed"
      : states.has(null)
        ? "unrecognized product-owned signal"
        : "conflicting product-owned signals";
  const evidence = present.map((signal) => `${signal.source}=${String(signal.value)}`).join("; ");
  return {
    availability: null,
    reasons: [`availability: ${reason}${evidence ? ` (${evidence})` : ""}`.slice(0, 4000)],
  };
}
