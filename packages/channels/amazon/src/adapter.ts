import type {
  ChannelAdapter,
  PlannedProduct,
  ProductIdentity,
} from "@crawl-automation/channels-core";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { AMAZON_ORIGIN, amazonProductAddress, amazonProductUrl } from "./address.js";
import { amazonStoreBrandScan } from "./store-listing.js";
import { amazonBrandScan } from "./brand-scan.js";
import { AMAZON_MAX_BYTES, amazonDocument, pageAsin, productRoot } from "./dom.js";
import { amazonErrors } from "./errors.js";
import { amazonFacts } from "./facts.js";
import { amazonProductFamily } from "./family.js";
import { AMAZON_FILE_ORIGINS } from "./images.js";
import { parseAmazonProduct, type AmazonRendered } from "./product.js";

function readProjection(raw: unknown, expectedUrl: string, owner: ProductIdentity): PlannedProduct {
  const decoded = ChannelProductEvidenceSchema.safeParse(raw);
  if (!decoded.success) {
    throw amazonErrors.create("AMAZON.PROJECTION_INVALID");
  }
  const evidence = decoded.data;
  const addresses = [expectedUrl, evidence.url].map(amazonProductAddress);
  const wrongAddress = addresses.some((address) => address.listingId !== evidence.listingId);
  if (
    evidence.channel !== "amazon" ||
    wrongAddress ||
    evidence.listingId !== owner.listingId ||
    evidence.variantId !== null ||
    owner.variantId !== null
  ) {
    throw amazonErrors.create("AMAZON.ASIN_CONFLICT");
  }
  const facts = evidence.factsCandidates.filter(
    (candidate) => candidate.scope === "selected-product",
  );
  return {
    evidence,
    facts: amazonFacts(facts.map((candidate) => candidate.html).join("\n") || null),
  };
}

/**
 * ScraperAPI render/premium/country choices belong to ScraperApiCaptureSettings.channels.amazon.
 */
export const AMAZON_HTTP_POLICY = {
  origins: [AMAZON_ORIGIN],
  maxBytes: AMAZON_MAX_BYTES,
  timeoutMs: 75_000,
} as const;

export const amazonAdapter: ChannelAdapter<AmazonRendered> = {
  id: "amazon",
  formulaFamily: "amazon-asin",
  captureModes: ["http"],
  httpPolicy: AMAZON_HTTP_POLICY,
  fileOrigins: AMAZON_FILE_ORIGINS,
  productAddress: amazonProductAddress,
  productUrl: amazonProductUrl,
  brandScan: amazonBrandScan,
  forBrandSource: (url) => ({
    ...amazonAdapter,
    brandScan:
      amazonAdapter.scanCapture?.(url) === "browser" ? amazonStoreBrandScan : amazonBrandScan,
  }),
  scanCapture: (url) =>
    /^\/stores\//i.test(URL.parse(url, AMAZON_ORIGIN)?.pathname ?? "") ? "browser" : "http",
  pageIdentity: (page) => ({
    listingId: pageAsin(productRoot(amazonDocument(page.html))),
    variantId: null,
  }),
  parseProduct: parseAmazonProduct,
  // Owner 2026-10-08: Amazon departments outside supplements (supplements sit under Health & Household).
  nonSupplementCategories: [
    "Baby Products",
    "Beauty & Personal Care",
    "Home & Kitchen",
    "Arts, Crafts & Sewing",
    "Industrial & Scientific",
    "Tools & Home Improvement",
    "Office Products",
    "Toys & Games",
    "Clothing, Shoes & Jewelry",
    "Electronics",
    "Patio, Lawn & Garden",
    "Automotive",
    "Pet Supplies",
    // Owner 2026-10-09 (CRAWLV3-214): Health & Household subcategories that hold no supplements, seen on the
    // 301 "no label source" Reviews: essential oils, mists and diffusers; toothpaste and mouthwash; bags and foil;
    // massage tools; gift wrap; pill organizers.
    "Aromatherapy",
    "Oral Care",
    "Household Supplies",
    "Wellness & Relaxation",
    "Stationery & Gift Wrapping Supplies",
    "Medication Aids",
  ],
  externalId: (parsed) => parsed.identity.listingId,
  productFamily: (parsed) => amazonProductFamily(parsed.rendered.family, parsed.identity.listingId),
  planning: {
    channel: "amazon",
    parserVersion: "amazon-rendered/1",
    projectionModule: "amazon.http-projection",
    projection: (rendered) => rendered.evidence,
    read: readProjection,
  },
};
