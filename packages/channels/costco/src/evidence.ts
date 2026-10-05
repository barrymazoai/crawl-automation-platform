import { schemaBrand, string, type JsonObject } from "@crawl-automation/channels-core";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { costcoContent } from "./content.js";
import { costcoImages } from "./images.js";
import { costcoErrors } from "./errors.js";
import type { CostcoChild } from "./children.js";

const pageUrl = (url: string) => url.split("#")[0] ?? url;

/** A non-default child keeps its own title and options; the page's gallery and facts are shared by its children. */
export function costcoEvidence(
  document: Document,
  selected: {
    product: JsonObject;
    url: string;
    listingId: string;
    child?: CostcoChild | undefined;
  },
) {
  const { product, url, listingId, child } = selected;
  const title = evidenceTitle(document, product, child);
  if (!title) {
    throw costcoErrors.create("COSTCO.PRODUCT_UNVERIFIED");
  }
  const content = costcoContent(document);
  return ChannelProductEvidenceSchema.parse({
    codec: "channel-product/1",
    channel: "costco",
    listingId,
    variantId: child?.itemNumber ?? null,
    url,
    title,
    brandRaw: schemaBrand(product.brand),
    variantOptions: child?.options ?? [],
    variants: [],
    detailsHtml: content.detailsHtml,
    factsCandidates: content.factsHtml
      ? [{ field: "page-facts", html: content.factsHtml, scope: "selected-product" }]
      : [],
    // A child's task uses the page's shared gallery as its own (owner 2026-10-05: children share one formula).
    imageCandidates: costcoImages(document, product, pageUrl(url)).map((image) => ({
      url: image,
      variantId: child?.itemNumber ?? null,
      basis: "product-gallery",
      verifiedOriginal: false,
    })),
    warnings: [],
  });
}

function evidenceTitle(document: Document, product: JsonObject, child: CostcoChild | undefined) {
  return child?.title ?? string(product.name) ?? document.querySelector("h1")?.textContent?.trim();
}
