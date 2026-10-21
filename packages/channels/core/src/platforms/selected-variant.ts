import type { PlatformVariant } from "./types.js";

/** Selection must be in the rendered form, not assumed from the requested query. */
export function selectedVariant(
  document: Document,
  variants: readonly PlatformVariant[],
  root: Element | null = null,
): string | null {
  const scope = root ?? document;
  const inputs = [
    ...scope.querySelectorAll(
      'form[action*="/cart/add"] input[name="id"], form[action*="/cart/add"] select[name="id"] option[selected], input[name="variation_id"]',
    ),
  ]
    .filter(
      (input) =>
        !input.closest('product-recommendations, [class*="recommend"], .related, .upsells'),
    )
    .map((input) => input.getAttribute("value"))
    .filter((value) => value && value !== "0");
  // Quick-add forms of other products (naturestruth.com lists 11 on a product page, 2026-10-20) name variants that
  // are not this product's; only this product's own variant IDs say what is selected. A page with a form for each of
  // its own variants (www.natrol.com's size buttons) selects none: the product is still identified, the variant is not.
  const own = [...new Set(inputs)].filter((value) =>
    variants.some((variant) => variant.id === value),
  );
  if (own.length === 1) {
    return own[0] ?? null;
  }
  return variants.length === 1 ? (variants[0]?.id ?? null) : null;
}
