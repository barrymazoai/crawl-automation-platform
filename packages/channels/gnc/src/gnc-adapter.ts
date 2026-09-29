import {
  pageText,
  type ChannelAdapter,
  type FactsText,
  type FetchedPage,
  type ParsedProduct,
} from "@crawl-automation/channels-core";
import { gncFactsTableComplete, parseGncProduct } from "@crawl-automation/v3-channels";
import type { ChannelProductEvidence, GncProductEvidence } from "@crawl-automation/v3-contracts";
import { GNC_ORIGIN, gncErrors, gncProductAddress, isSku } from "./gnc-address.js";
import { gncBrandScan } from "./gnc-brand-scan.js";
import { gncCommerce } from "./gnc-commerce.js";
import { gncProductFamily, readGncOptions, type GncRendered } from "./gnc-options.js";

/**
 * The Supplement Facts as text (`html-table-first/1`): a complete HTML facts table is the only formula source; an
 * incomplete one keeps the images. Completeness is GNC's own rule, checked on real pages on 2026-09-28.
 */
function factsOf(product: GncProductEvidence): FactsText {
  const verdict = gncFactsTableComplete(product.factsHtml);
  const text = product.factsHtml ? pageText(product.factsHtml) || null : null;
  return { text, complete: verdict.complete, missing: verdict.reasons };
}

/** GNC's own evidence in the channel-independent shape the planner and Reviews read. */
function evidenceOf(product: GncProductEvidence): ChannelProductEvidence {
  const basis = { "sku-jsonld": "selected-gallery", "product-gallery": "product-gallery" } as const;
  return {
    codec: "channel-product/1",
    channel: "gnc",
    listingId: product.sku,
    variantId: null,
    url: product.url,
    title: product.title,
    brandRaw: product.brandRaw,
    variantOptions: [],
    variants: product.variantUrls.map((url) => ({
      ...gncProductAddress(url),
      title: null,
    })),
    detailsHtml: product.detailsHtml,
    factsCandidates: product.factsHtml
      ? [{ field: "supplement-facts", html: product.factsHtml, scope: "selected-product" }]
      : [],
    imageCandidates: product.imageCandidates.map((image) => ({
      url: image.url,
      variantId: null,
      basis: basis[image.basis],
      verifiedOriginal: false,
    })),
    warnings: [...product.warnings],
  };
}

function parseProduct(page: FetchedPage): ParsedProduct<GncRendered> {
  const address = gncProductAddress(page.url);
  if (!isSku(address.listingId)) {
    // A family page lists several SKUs; brand scans queue its members, never the family page itself.
    throw gncErrors.create("GNC.FAMILY_PAGE", { details: { listingId: address.listingId } });
  }
  const product = parseGncProduct(page.html, address.url, address.listingId);
  return {
    channel: "gnc",
    identity: { listingId: product.sku, variantId: null },
    rendered: { product, options: readGncOptions(page.html) },
    evidence: evidenceOf(product),
    commerce: gncCommerce(page.html, product.sku),
    variants: product.variantUrls.map(gncProductAddress),
    facts: factsOf(product),
  };
}

/**
 * gnc.com. Product and brand pages are fetched through ScraperAPI as plain HTML (checked 2026-09-28: no challenge);
 * each size and flavour has its own 6-digit SKU page. The formula planner does not read GNC pages yet, so there is
 * no `planning` until the shared label workflow (M5) takes GNC.
 */
export const gncAdapter: ChannelAdapter<GncRendered> = {
  id: "gnc",
  captureModes: ["http"],
  httpPolicy: { origins: [GNC_ORIGIN], maxBytes: 2 * 1024 * 1024, timeoutMs: 70_000 },
  brandScan: gncBrandScan,
  productAddress: gncProductAddress,
  parseProduct,
  productFamily: gncProductFamily,
};
