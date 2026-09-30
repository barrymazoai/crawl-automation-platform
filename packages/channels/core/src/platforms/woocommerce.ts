import { amount, availability } from "./commerce.js";
import { identifier, object, parsePageJson, records, string } from "./json.js";
import { readJsonLdProduct, selectedVariant } from "./jsonld.js";
import { platformPageErrors } from "./errors.js";
import type { PlatformContext, PlatformProduct, PlatformVariant } from "./types.js";
import { variantUrl } from "./urls.js";

function variationAddress(url: string, variant: Record<string, unknown>, id: string): string {
  const address = new URL(variantUrl(url, "variation_id", id));
  for (const [key, value] of Object.entries(object(variant.attributes) ?? {})) {
    if (key.startsWith("attribute_") && typeof value === "string" && value) {
      address.searchParams.set(key, value);
    }
  }
  return address.href;
}

function wooVariants(form: Element, url: string): PlatformVariant[] {
  const raw = form.getAttribute("data-product_variations");
  if (!raw || raw === "false") {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  return records(parsePageJson(raw)).map((variant) => {
    const id = identifier(variant.variation_id);
    if (!id) {
      throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
    }
    return {
      id,
      title:
        Object.values(object(variant.attributes) ?? {})
          .map(String)
          .join(" / ") || null,
      url: variationAddress(url, variant, id),
      price: amount(variant.display_price),
      availability: availability(variant.is_in_stock),
      image: string(object(variant.image)?.src),
    };
  });
}

export function readWooCommerceProduct(
  document: Document,
  context: PlatformContext,
): PlatformProduct {
  const product = readJsonLdProduct(document, context);
  const form = document.querySelector("form.variations_form");
  const productId =
    form?.getAttribute("data-product_id") ??
    document.querySelector('[name="add-to-cart"]')?.getAttribute("value") ??
    product.productId;
  const variants = form ? wooVariants(form, product.url) : [];
  const selected = selectedVariant(document, variants, form);
  if (form && !selected) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const variant = variants.find((entry) => entry.id === selected);
  return {
    ...product,
    platform: "woocommerce",
    productId,
    variants,
    selectedVariantId: selected,
    commerce: variant
      ? {
          ...product.commerce,
          price: variant.price,
          availability: variant.availability,
          priceStatus: variant.price === null ? "not_observed" : "observed",
        }
      : product.commerce,
  };
}
