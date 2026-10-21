import {
  descriptionImages,
  factsSection,
  imageUrls,
  renderedProductDetails,
  sectionImages,
} from "./content.js";
import { productContentScope } from "./content-scope.js";
import { pageText } from "../page-text.js";
import type { PlatformContext } from "./types.js";
import { variantGalleryImages } from "./variant-gallery.js";

/** All platform readers share ownership and observed-image ordering. */
export function readProductContent(
  document: Document,
  context: PlatformContext & { productId: string },
  data: {
    images: string[];
    detailsHtml: string | null;
    factsHtml?: string | null;
    selectedVariantId?: string | null;
  },
) {
  const scope = productContentScope(document, context);
  const detailsHtml =
    data.detailsHtml && pageText(data.detailsHtml)
      ? data.detailsHtml
      : renderedProductDetails(scope);
  const gallery = variantGalleryImages(document, context, data.selectedVariantId);
  const scopedImages = gallery.length
    ? gallery
    : [
        ...data.images,
        ...sectionImages(scope.root, scope.identity),
        ...scope.sections.flatMap((section) => sectionImages(section, scope.identity)),
      ];
  return {
    detailsHtml,
    ...factsSection(scope, data.factsHtml ?? detailsHtml),
    images: imageUrls(
      [
        ...scopedImages,
        ...descriptionImages(document, data.detailsHtml),
        ...(detailsHtml === data.detailsHtml ? [] : descriptionImages(document, detailsHtml)),
      ],
      context,
    ),
  };
}
