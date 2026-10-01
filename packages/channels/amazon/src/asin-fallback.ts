import type { AmazonElement } from "./dom.js";

const FEATURE_SELECTOR = [
  ":scope > #centerCol > #title_feature_div[data-csa-c-asin]",
  ":scope > #centerCol > #twister_feature_div[data-csa-c-asin]",
].join(", ");
const OFFER_SELECTOR = [
  ":scope > #rightCol > #olpLinkWidget_feature_div",
  ":scope > #centerCol > #olp_feature_div",
]
  .map(
    (selector) =>
      `${selector} > #all-offers-display > form > input#all-offers-display-params[data-asin]`,
  )
  .join(", ");

/**
 * These top-level title/twister widgets and offer controls identify the displayed product.
 * Exact child paths exclude nested recommendations, sponsored cards and other variation ASINs.
 * Do not filter malformed values: the caller must refuse incomplete or conflicting identity.
 */
export function fallbackAsins(root: AmazonElement): string[] {
  return [
    ...[...root.querySelectorAll(FEATURE_SELECTOR)].map(
      (element) => element.getAttribute("data-csa-c-asin") ?? "",
    ),
    ...[...root.querySelectorAll(OFFER_SELECTOR)].map(
      (element) => element.getAttribute("data-asin") ?? "",
    ),
  ];
}
