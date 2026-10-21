import { sectionImages } from "./content.js";
import { allowedContent, contentIdentity } from "./content-policy.js";
import type { PlatformContext } from "./types.js";

/** A rendered variant gallery can live beside the product info instead of inside its usual product root. */
export function variantGalleryImages(
  document: Document,
  context: PlatformContext & { productId: string },
  selectedVariantId?: string | null,
): string[] {
  const identity = contentIdentity(null, context);
  const galleries = [...document.querySelectorAll('main .product-images [id^="pdp-main-slider-"]')]
    .filter((node) => /^pdp-main-slider-\d+$/.test(node.id) && allowedContent(node, identity))
    .map((node) => sectionImages(node, identity));
  if (selectedVariantId === undefined) {
    return [];
  }
  if (selectedVariantId === null) {
    return galleries.flat();
  }
  return galleries
    .filter((urls) =>
      urls.some((raw) => new URL(raw, context.url).pathname.split("/").includes(selectedVariantId)),
    )
    .flat();
}
