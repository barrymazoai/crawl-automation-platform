import {
  imageUrls,
  object,
  schemaImages,
  sectionImages,
  string,
  type JsonObject,
} from "@crawl-automation/channels-core";
import { COSTCO_IMAGE_ORIGINS } from "./policy.js";
import { costcoPageProps } from "./page-data.js";

const records = (value: unknown) =>
  (Array.isArray(value) ? value : []).map(object).filter((entry) => entry !== null);

/** Full-size attachment URLs as observed, not thumbnail URLs or invented AVIF→JPEG replacements. */
function originalImages(props: JsonObject[], itemNumber: string | null): string[] {
  return props
    .filter((entry) => itemNumber && entry.selectedChildItemNumber === itemNumber)
    .flatMap((entry) => records(entry.brandfolderAsset))
    .flatMap((asset) => records(object(asset.attachments)?.data))
    .flatMap((attachment) => {
      const attributes = object(attachment.attributes);
      const url = string(attributes?.cdn_url);
      return url && ["image/jpeg", "image/png", "image/webp"].includes(String(attributes?.mimetype))
        ? [url]
        : [];
    });
}

export function costcoImages(document: Document, product: JsonObject, url: string): string[] {
  const originals = originalImages(costcoPageProps(document), string(product.sku));
  const gallery = document.querySelector('[data-testid="product-hero-carousel"]');
  const details = document.querySelector('[data-testid="Accordion_product_details"]');
  const observed = [...schemaImages(product.image), ...sectionImages(gallery)];
  return imageUrls([...(originals.length ? originals : observed), ...sectionImages(details)], {
    url,
    siteKey: "costco.com",
    imageOrigins: COSTCO_IMAGE_ORIGINS,
  });
}
