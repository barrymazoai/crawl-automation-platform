/** Existing website variant normalization, shared by harvest and offline verification. */
export function normalizePlatformVariants(product, productUrl) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const optionNames = (Array.isArray(product?.options) ? product.options : [])
    .map((option) => (typeof option === "string" ? option : option?.name))
    .filter(Boolean);
  return variants.map((variant) => {
    const options = {};
    ["option1", "option2", "option3"].forEach((key, index) => {
      const value = variant?.[key];
      if (value != null && String(value).trim() !== "") {
        options[optionNames[index] || `option${index + 1}`] = String(value).trim();
      }
    });
    const id = variant?.id != null ? String(variant.id) : "";
    return {
      ...(id ? { variantId: id } : {}),
      ...(variant?.sku ? { sku: String(variant.sku).trim() } : {}),
      ...(variant?.title ? { title: String(variant.title).trim() } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
      ...(variant?.price != null ? { price: String(variant.price) } : {}),
      ...(typeof variant?.price_currency === "string" && variant.price_currency.trim()
        ? { currency: variant.price_currency.trim() } : {}),
      ...(typeof variant?.available === "boolean" ? { available: variant.available } : {}),
      ...(id ? { url: `${productUrl.split("?")[0]}?variant=${id}` } : {}),
      ...(variant?.featured_image?.src ? { imageUrl: String(variant.featured_image.src) } : {}),
    };
  }).filter((variant) => variant.variantId || variant.sku || variant.title);
}
