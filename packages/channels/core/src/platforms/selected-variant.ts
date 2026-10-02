import { platformPageErrors } from "./errors.js";
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
  const unique = [...new Set(inputs)];
  if (unique.length > 1 || (unique[0] && !variants.some((variant) => variant.id === unique[0]))) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  return unique[0] ?? (variants.length === 1 ? (variants[0]?.id ?? null) : null);
}
