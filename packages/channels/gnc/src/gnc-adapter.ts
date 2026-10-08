import {
  pageText,
  type ChannelAdapter,
  type FactsText,
  type FetchedPage,
  type ParsedProduct,
  type PlannedProduct,
  type ProductIdentity,
} from "@crawl-automation/channels-core";
import {
  ChannelProductEvidenceSchema,
  type ChannelProductEvidence,
  type GncProductEvidence,
} from "@crawl-automation/v3-contracts";
import { gncFactsTableComplete } from "./gnc-facts.js";
import { gncPageErrors } from "./gnc-page-errors.js";
import { parseGncProduct } from "./gnc-product.js";
import { GNC_ORIGIN, gncProductAddress } from "./gnc-address.js";
import { gncPageIdentity } from "./gnc-identity.js";
import { gncLabelCore } from "./label-core.js";
import { gncBrandScan } from "./gnc-brand-scan.js";
import { gncCommerce } from "./gnc-commerce.js";
import { gncBreadcrumb } from "./gnc-breadcrumb.js";
import { gncProductFamily, readGncOptions, type GncRendered } from "./gnc-options.js";

/**
 * The Supplement Facts as text (`html-table-first/1`): a complete HTML facts table is the only formula source; an
 * incomplete one keeps the images. Completeness is GNC's own rule, checked on real pages on 2026-09-28.
 */
function factsOf(factsHtml: string | null): FactsText {
  const verdict = gncFactsTableComplete(factsHtml);
  const text = factsHtml ? pageText(factsHtml) || null : null;
  return { text, complete: verdict.complete, missing: verdict.reasons };
}

/**
 * The planner reads the saved projection (GNC's product evidence) back: the same product as the observation, and
 * the same facts rule as the capture, so capture and planner never disagree about the formula source.
 */
function readProjection(
  projection: unknown,
  expectedUrl: string,
  owner: ProductIdentity,
): PlannedProduct {
  const evidence = ChannelProductEvidenceSchema.parse(projection);
  const sameHost = new URL(evidence.url).hostname === new URL(expectedUrl).hostname;
  const ownProduct = evidence.listingId === owner.listingId;
  if (
    evidence.channel !== "gnc" ||
    evidence.variantId !== null ||
    owner.variantId !== null ||
    !sameHost ||
    !ownProduct
  ) {
    throw gncPageErrors.create("GNC.IDENTITY_CONFLICT", {
      details: { listingId: owner.listingId },
    });
  }
  const facts = evidence.factsCandidates.find(
    (candidate) => candidate.scope === "selected-product",
  );
  return { evidence, facts: factsOf(facts?.html ?? null) };
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
  const identity = gncPageIdentity(page);
  const product = parseGncProduct(page.html, address.url, identity.listingId);
  return {
    channel: "gnc",
    identity,
    rendered: { product, options: readGncOptions(page.html) },
    evidence: evidenceOf(product),
    commerce: gncCommerce(page.html, product.sku),
    variants: product.variantUrls.map(gncProductAddress),
    facts: factsOf(product.factsHtml),
    categories: gncBreadcrumb(page.html),
  };
}

/**
 * gnc.com. Product and brand pages are fetched through ScraperAPI as plain HTML (checked 2026-09-28: no challenge);
 * each size and flavour has its own 6-digit SKU page. The planner reads the product evidence as the projection;
 * with a complete facts table (text facts first) that table is the only formula source.
 */
export const gncAdapter: ChannelAdapter<GncRendered> = {
  id: "gnc",
  captureModes: ["http"],
  httpPolicy: { origins: [GNC_ORIGIN], maxBytes: 2 * 1024 * 1024, timeoutMs: 70_000 },
  brandScan: gncBrandScan,
  planning: {
    channel: "gnc",
    parserVersion: "gnc-rendered/1",
    projectionModule: "gnc.http-projection",
    projection: (rendered: GncRendered) => evidenceOf(rendered.product),
    read: readProjection,
    corePolicy: "gnc-label-core/1",
    labelCore: gncLabelCore,
  },
  productAddress: gncProductAddress,
  pageIdentity: gncPageIdentity,
  parseProduct,
  productFamily: gncProductFamily,
  // Owner 2026-10-08: shaker bottles, apparel and other gear.
  nonSupplementCategories: ["Equipment & Accessories", "Apparel"],
};
