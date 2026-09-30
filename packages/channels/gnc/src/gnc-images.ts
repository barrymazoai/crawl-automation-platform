import type { GncProductEvidence } from "@crawl-automation/v3-contracts";
import { cleanText, hasClass, isHidden, within, type Element } from "./gnc-dom.js";
import type { JsonRecord } from "./gnc-json-ld.js";
import { gncPageErrors } from "./gnc-page-errors.js";

type ImageCandidate = GncProductEvidence["imageCandidates"][number];
type Basis = ImageCandidate["basis"];

/** Images of other products (tiles, recommendations, another data-pid) or of hidden templates are never taken. */
function foreign(image: Element, sku: string): boolean {
  return within(
    image,
    (node) =>
      isHidden(node) ||
      hasClass(node, "product-tile") ||
      hasClass(node, "recommendation") ||
      hasClass(node, "recommendations") ||
      (node.attribs["data-pid"] !== undefined && node.attribs["data-pid"] !== sku),
  );
}

/**
 * The product's own gallery: the old container, or the current thumbnail grid when the image's alt text is the
 * verified product title (ownership is never inferred from a file name).
 */
function inGallery(image: Element, title: string): boolean {
  const known = within(
    image,
    (node) => hasClass(node, "product-image-container") || node.attribs.id === "product-images",
  );
  const alt = cleanText(image.attribs.alt ?? "")
    .replace(/\s*\|\s*GNC$/, "")
    .trim();
  const grid = within(image, (node) => hasClass(node, "product-thumbnails-grid"));
  return known || (grid && alt === cleanText(title));
}

/** The product's image candidates: its JSON-LD images first, then its gallery. PDFs are never taken. */
export function gncImages(input: {
  product: JsonRecord;
  elements: Element[];
  page: { url: string; sku: string; title: string };
}) {
  const images = new Map<string, ImageCandidate>();
  const add = (raw: unknown, basis: Basis) => {
    if (typeof raw !== "string") {
      return;
    }
    let url: URL;
    try {
      url = new URL(raw, input.page.url);
    } catch (error) {
      throw gncPageErrors.create("GNC.IMAGE_URL_INVALID", { cause: error });
    }
    const clean =
      url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash;
    if (clean && !/\.pdf$/i.test(url.pathname)) {
      images.set(url.href, { url: url.href, basis, verifiedOriginal: false });
    }
  };
  const declared = input.product.image;
  for (const image of Array.isArray(declared) ? declared : [declared]) {
    add(image, "sku-jsonld");
  }
  for (const element of input.elements) {
    if (
      element.name !== "img" ||
      foreign(element, input.page.sku) ||
      !inGallery(element, input.page.title)
    ) {
      continue;
    }
    const { attribs } = element;
    add(attribs["data-zoom-url"] ?? attribs["data-src"] ?? attribs.src, "product-gallery");
  }
  return [...images.values()];
}
