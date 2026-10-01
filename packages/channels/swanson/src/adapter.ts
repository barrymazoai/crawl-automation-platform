import {
  factsFromHtml,
  type ChannelAdapter,
  type FactsText,
  type FetchedPage,
  type HttpPolicy,
  type ParsedProduct,
  type PlannedProduct,
  type ProductAddress,
  type ProductIdentity,
} from "@crawl-automation/channels-core";
import { swansonFamily } from "./family.js";
import { swansonExternalId } from "./history-id.js";
import { swansonBrandScan } from "./brand-scan.js";
import { swansonLabelCore } from "./label-core.js";
import { SWANSON_ORIGIN, swansonProductAddress } from "./swanson-address.js";
import { swansonIdentityMapping } from "./identity-map.js";
import { parseSwansonRenderedProduct } from "./swanson-evidence.js";
import { swansonVariantChoices } from "./swanson-variants.js";
import { parseSwansonStaticHtml, parseSwansonStaticIdentity } from "./swanson-static-html.js";
import type {
  ChannelProductEvidence,
  SwansonRenderedProduct,
} from "@crawl-automation/v3-contracts";

/** A Swanson product URL: `/p/<handle>`, optionally with `?variant=<id>`. The listing ID is the handle. */
function productAddress(url: string): ProductAddress {
  const address = swansonProductAddress(url);
  return { url: address.url.href, listingId: address.handle, variantId: address.variantId };
}

/** After capture the page names its own identity: the Shopify product ID and the selected variant. */
function selectedIdentity(
  rendered: Pick<SwansonRenderedProduct, "canonicalUrl" | "selectedForms">,
): {
  listingId: string;
  variantId: string;
} {
  const { productId, variantId } = swansonIdentityMapping(rendered);
  return { listingId: productId, variantId };
}

/** The canonical handle and selected variant are page evidence; Shopify's numeric product ID is kept separately. */
function pageIdentity(page: FetchedPage): ProductIdentity {
  const rendered = parseSwansonStaticIdentity(page.html, page.url);
  const { handle, variantId } = swansonIdentityMapping(rendered);
  return { listingId: handle, variantId };
}

/** The projection the formula planner reads: the rendered page without the family option list. */
function projection(rendered: SwansonRenderedProduct): unknown {
  const { variantPicker: _options, ...product } = rendered;
  return product;
}

/** The selected product's supplement facts as text, judged by the shared completeness rule. */
function factsOf(evidence: ChannelProductEvidence): FactsText {
  const selected = evidence.factsCandidates.find(
    (candidate) => candidate.scope === "selected-product",
  );
  return factsFromHtml(selected?.html ?? null);
}

/** The planner reads the saved projection back with the same parser and facts rule as the capture. */
function readProjection(
  projection: unknown,
  expectedUrl: string,
  owner: ProductIdentity,
): PlannedProduct {
  const evidence = parseSwansonRenderedProduct(projection, expectedUrl, owner);
  return { evidence, facts: factsOf(evidence) };
}

/** A bounded raw HTML read of one public product page (ScraperAPI); no JS, cookies or redirects. */
export const SWANSON_HTTP_POLICY: HttpPolicy = {
  origins: [SWANSON_ORIGIN],
  maxBytes: 6 * 1024 * 1024,
  timeoutMs: 75_000,
};

/**
 * swansonvitamins.com. Product pages are server-rendered, so a static HTTP fetch (ScraperAPI) is enough; every
 * size has its own URL.
 */
export const swansonAdapter: ChannelAdapter<SwansonRenderedProduct> = {
  id: "swanson",
  captureModes: ["http"],
  httpPolicy: SWANSON_HTTP_POLICY,
  brandScan: swansonBrandScan,
  planning: {
    channel: "swanson",
    parserVersion: "swanson-rendered/1",
    projectionModule: "swanson.http-projection",
    projection,
    read: readProjection,
    corePolicy: "swanson-label-core/1",
    labelCore: swansonLabelCore,
  },
  productAddress,
  pageIdentity,
  productFamily: swansonFamily,
  externalId: swansonExternalId,
  parseProduct(page: FetchedPage): ParsedProduct<SwansonRenderedProduct> {
    const rendered = parseSwansonStaticHtml(page.html, page.url, page.capturedAt);
    const identity = selectedIdentity(rendered);
    const evidence = parseSwansonRenderedProduct(rendered, page.url, identity);
    const variants = swansonVariantChoices(rendered).choices.map((choice) =>
      productAddress(choice.url),
    );
    return {
      channel: "swanson",
      identity,
      rendered,
      evidence,
      commerce: rendered.commerce ?? null,
      variants,
      facts: factsOf(evidence),
    };
  },
};
