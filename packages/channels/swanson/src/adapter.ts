import {
  pageText,
  type ChannelAdapter,
  type FactsText,
  type FetchedPage,
  type ParsedProduct,
  type ProductAddress,
} from "@crawl-automation/channels-core";
import {
  SWANSON_HTTP_POLICY,
  factsTextComplete,
  factsTextFromHtml,
  parseSwansonRenderedProduct,
  parseSwansonStaticHtml,
  swansonProductAddress,
  swansonVariantChoices,
} from "@crawl-automation/v3-channels";
import { swansonFamily } from "./family.js";
import { swansonExternalId } from "./history-id.js";
import { swansonBrandScan } from "./brand-scan.js";
import { swansonLabelCore } from "./label-core.js";
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
function selectedIdentity(rendered: SwansonRenderedProduct): {
  listingId: string;
  variantId: string;
} {
  const form = rendered.selectedForms[0];
  const variantId = form?.variantIds[0];
  if (!form || !variantId) {
    // parseSwansonStaticHtml guarantees one selected form with one variant; this only narrows the type.
    throw new Error("SWANSON.IDENTITY_UNVERIFIED");
  }
  return { listingId: form.productId, variantId };
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
  const text = selected ? factsTextFromHtml(selected.html) : null;
  const verdict = factsTextComplete(text);
  return { text, complete: verdict.complete, missing: verdict.reasons };
}

/**
 * swansonvitamins.com. Product pages are server-rendered, so a static HTTP fetch (ScraperAPI) is enough; every
 * size has its own URL. Parsing reuses the tested v3-channels functions unchanged.
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
    corePolicy: "swanson-label-core/1",
    labelCore: swansonLabelCore,
  },
  productAddress,
  productFamily: swansonFamily,
  externalId: swansonExternalId,
  parseProduct(page: FetchedPage): ParsedProduct<SwansonRenderedProduct> {
    const rendered = parseSwansonStaticHtml(page.html, page.url, page.capturedAt, (element) =>
      pageText(element.innerHTML),
    );
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
