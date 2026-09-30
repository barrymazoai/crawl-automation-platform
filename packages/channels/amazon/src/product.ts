import type { FetchedPage, ParsedProduct } from "@crawl-automation/channels-core";
import {
  ChannelProductEvidenceSchema,
  type ChannelProductEvidence,
} from "@crawl-automation/v3-contracts";
import { amazonProductAddress } from "./address.js";
import { amazonCommerce } from "./commerce.js";
import {
  amazonDocument,
  pageAsin,
  productRoot,
  textOf,
  type AmazonDocument,
  type AmazonElement,
} from "./dom.js";
import { amazonErrors } from "./errors.js";
import { amazonFacts, amazonFactsHtml } from "./facts.js";
import { extractVariationFamily, type AmazonVariationFamily } from "./family.js";
import { amazonImages } from "./images.js";
import { amazonScriptData } from "./script-data.js";

export interface AmazonRendered {
  evidence: ChannelProductEvidence;
  family: AmazonVariationFamily | null;
  capturedAt: string;
}

function titleOf(root: AmazonElement): string {
  const titles = [
    ...new Set([...root.querySelectorAll("#productTitle")].map(textOf).filter(Boolean)),
  ];
  if (titles.length !== 1 || !titles[0]) {
    throw amazonErrors.create("AMAZON.PRODUCT_UNVERIFIED");
  }
  return titles[0];
}

/**
 * The byline's brand, with Amazon's UI wrapper removed; never inferred from the title or seller.
 */
function brandOf(root: AmazonElement): string | null {
  const text = textOf(root.querySelector("#bylineInfo"));
  const brand = text.replace(/^Visit the (.+) Store$/i, "$1").replace(/^Brand\s*:\s*/i, "");
  return brand || null;
}

function detailsHtml(document: AmazonDocument): string | null {
  return (
    ["feature-bullets", "productDescription"]
      .flatMap((id) => {
        const element = document.getElementById(id);
        return element && textOf(element) ? [element.outerHTML] : [];
      })
      .join("\n") || null
  );
}

function evidenceOf(page: FetchedPage, document: AmazonDocument, root: AmazonElement) {
  const asin = pageAsin(root);
  const data = amazonScriptData(document);
  const family = extractVariationFamily(data, asin);
  const facts = amazonFactsHtml(document);
  const images = amazonImages(root, data);
  const variants =
    family?.members
      .filter((member) => member.asin !== asin)
      .map((member) => ({
        ...amazonProductAddress(`/dp/${member.asin}`),
        title: member.label,
      })) ?? [];
  const evidence = ChannelProductEvidenceSchema.parse({
    codec: "channel-product/1",
    channel: "amazon",
    listingId: asin,
    variantId: null,
    url: amazonProductAddress(page.url).url,
    title: titleOf(root),
    brandRaw: brandOf(root),
    variantOptions: family?.dimensions ?? [],
    variants,
    detailsHtml: detailsHtml(document),
    factsCandidates: facts
      ? [{ field: "amazon-facts", html: facts, scope: "selected-product" }]
      : [],
    imageCandidates: images,
    warnings: [...data.warnings, ...(images.length ? [] : ["AMAZON.GALLERY_UNVERIFIED"])],
  });
  return { evidence, family, capturedAt: page.capturedAt };
}

/**
 * Parse archived bytes. A request for a different ASIN still reports this page's own identity to
 * core.
 */
export function parseAmazonProduct(page: FetchedPage): ParsedProduct<AmazonRendered> {
  amazonProductAddress(page.url);
  const document = amazonDocument(page.html);
  const root = productRoot(document);
  const rendered = evidenceOf(page, document, root);
  const { evidence } = rendered;
  return {
    channel: "amazon",
    identity: { listingId: evidence.listingId, variantId: null },
    rendered,
    evidence,
    commerce: amazonCommerce(root, evidence.listingId),
    variants: evidence.variants.map(({ title: _title, ...address }) => address),
    facts: amazonFacts(evidence.factsCandidates[0]?.html ?? null),
  };
}
