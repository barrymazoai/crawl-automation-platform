import { descriptionImages, factsSection, imageUrls, sectionImages } from "./content.js";
import { productContentScope } from "./content-scope.js";
import type { PlatformContext } from "./types.js";

/** All platform readers share ownership, ordering and the image-origin boundary. */
export function readProductContent(
  document: Document,
  context: PlatformContext & { productId: string },
  data: { images: string[]; detailsHtml: string | null; factsHtml?: string | null },
) {
  const scope = productContentScope(document, context);
  return {
    ...factsSection(scope, data.factsHtml ?? data.detailsHtml),
    images: imageUrls(
      [
        ...data.images,
        ...sectionImages(scope.root, scope.identity),
        ...descriptionImages(document, data.detailsHtml),
        ...scope.sections.flatMap((section) => sectionImages(section, scope.identity)),
      ],
      context,
    ),
  };
}
