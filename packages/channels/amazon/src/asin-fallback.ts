/** The part of a parsed product root this reader needs (kept here so dom.ts can import this file). */
interface ProductRoot {
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }>;
}

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
export function fallbackAsins(root: ProductRoot): string[] {
  return [
    ...[...Array.from(root.querySelectorAll(FEATURE_SELECTOR))].map(
      (element) => element.getAttribute("data-csa-c-asin") ?? "",
    ),
    ...[...Array.from(root.querySelectorAll(OFFER_SELECTOR))].map(
      (element) => element.getAttribute("data-asin") ?? "",
    ),
  ];
}
