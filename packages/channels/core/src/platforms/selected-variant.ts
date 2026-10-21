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

/**
 * The rendered form decides. When no form singles one out, the address's own `variant` / `variation_id` counts if it
 * is one of this product's variants (shop.katefarms.com draws no cart input, 2026-10-20; one task per variant URL,
 * step 2, 2026-10-21). A base address of a multi-variant product with no selection stays the base product (null).
 */
export function selectedOrRequestedVariant(
  document: Document,
  variants: readonly PlatformVariant[],
  at: { url: string; root?: Element | null },
): string | null {
  const rendered = selectedVariant(document, variants, at.root ?? null);
  if (rendered) {
    return rendered;
  }
  const query = new URL(at.url).searchParams;
  const requested = query.get("variant") ?? query.get("variation_id");
  return requested && variants.some((entry) => entry.id === requested) ? requested : null;
}
