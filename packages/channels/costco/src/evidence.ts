import { schemaBrand, string, type JsonObject } from "@crawl-automation/channels-core";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { costcoContent } from "./content.js";
import { costcoImages } from "./images.js";
import { costcoErrors } from "./errors.js";

export function costcoEvidence(
  document: Document,
  selected: { product: JsonObject; url: string; listingId: string },
) {
  const { product, url, listingId } = selected;
  const title = string(product.name) ?? document.querySelector("h1")?.textContent?.trim();
  if (!title) {
    throw costcoErrors.create("COSTCO.PRODUCT_UNVERIFIED");
  }
  const content = costcoContent(document);
  return ChannelProductEvidenceSchema.parse({
    codec: "channel-product/1",
    channel: "costco",
    listingId,
    variantId: null,
    url,
    title,
    brandRaw: schemaBrand(product.brand),
    variantOptions: [],
    variants: [],
    detailsHtml: content.detailsHtml,
    factsCandidates: content.factsHtml
      ? [{ field: "page-facts", html: content.factsHtml, scope: "selected-product" }]
      : [],
    imageCandidates: costcoImages(document, product, url).map((image) => ({
      url: image,
      variantId: null,
      basis: "product-gallery",
      verifiedOriginal: false,
    })),
    warnings: [],
  });
}
