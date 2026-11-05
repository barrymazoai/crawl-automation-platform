import type {
  ChannelPlanning,
  ChannelAdapter,
  PlannedProduct,
  ProductIdentity,
} from "@crawl-automation/channels-core";
import { amazonLabelFormats, ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { amazonProductAddress, amazonProductUrl } from "./address.js";
import { amazonStoreBrandScan } from "./store-listing.js";
import { amazonSiteBrandScan } from "./brand-scan.js";
import { AMAZON_MAX_BYTES, amazonDocument, pageAsin, productRoot } from "./dom.js";
import { amazonErrors } from "./errors.js";
import { amazonFacts } from "./facts.js";
import { isAmazonChallenge } from "./access-challenge.js";
import { amazonProductFamily } from "./family.js";
import { AMAZON_FILE_ORIGINS } from "./images.js";
import { parseAmazonProduct, type AmazonRendered } from "./product.js";
import { AMAZON_IN, AMAZON_US, type AmazonSite } from "./site.js";

function readProjection(
  site: AmazonSite,
  input: { raw: unknown; expectedUrl: string; owner: ProductIdentity },
): PlannedProduct {
  const { raw, expectedUrl, owner } = input;
  const decoded = ChannelProductEvidenceSchema.safeParse(raw);
  if (!decoded.success) {
    throw amazonErrors.create("AMAZON.PROJECTION_INVALID");
  }
  const evidence = decoded.data;
  const addresses = [expectedUrl, evidence.url].map((url) => amazonProductAddress(url, site));
  const wrongAddress = addresses.some((address) => address.listingId !== evidence.listingId);
  if (
    evidence.channel !== site.channel ||
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
 * ScraperAPI render/premium/country choices belong to ScraperApiCaptureSettings.channels.<channel>.
 */
const httpPolicy = (site: AmazonSite) =>
  ({
    origins: [site.origin],
    maxBytes: AMAZON_MAX_BYTES,
    timeoutMs: 75_000,
    accessChallenge: isAmazonChallenge,
  }) as const;

export const AMAZON_HTTP_POLICY = httpPolicy(AMAZON_US);

// Owner 2026-10-08: Amazon departments outside supplements (supplements sit under Health & Household). amazon.in
// names its departments differently (supplements sit under Health & Personal Care); its own list is added from
// its first brand scans' Reviews, until then these names simply never match there.
const NON_SUPPLEMENT_CATEGORIES = [
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
  // Owner 2026-10-09: groceries are not supplements either.
  "Grocery & Gourmet Food",
];

function planning(site: AmazonSite): ChannelPlanning<AmazonRendered> {
  return {
    channel: site.channel,
    parserVersion: site.parserVersion,
    projectionModule: `${site.channel}.http-projection`,
    projection: (rendered) => rendered.evidence,
    read: (raw, expectedUrl, owner) => readProjection(site, { raw, expectedUrl, owner }),
    ...(site === AMAZON_US ? {} : { labelFormats: amazonLabelFormats(site.channel) }),
  };
}

/**
 * KAN-243: one adapter per Amazon storefront, every page reader shared. amazon.in labels are read in the Indian label
 * formats too (the label task's `labelFormats`). Its formula family is its own: a US formula is reused for an Indian
 * listing only after the cross-market check says both are the same product (owner 2026-11-05, plan §10.4).
 */
export function amazonSiteAdapter(site: AmazonSite): ChannelAdapter<AmazonRendered> {
  const brandScan = amazonSiteBrandScan(site);
  const adapter: ChannelAdapter<AmazonRendered> = {
    id: site.channel,
    formulaFamily: site === AMAZON_US ? "amazon-asin" : `${site.channel}-asin`,
    captureModes: ["http"],
    httpPolicy: httpPolicy(site),
    fileOrigins: AMAZON_FILE_ORIGINS,
    productAddress: (raw) => amazonProductAddress(raw, site),
    productUrl: (asin) => amazonProductUrl(asin, site),
    brandScan,
    // Store pages are read in a browser on amazon.com only; another storefront's sources are Brand-filter searches.
    forBrandSource: (url) => ({
      ...adapter,
      brandScan: adapter.scanCapture?.(url) === "browser" ? amazonStoreBrandScan : brandScan,
    }),
    scanCapture: (url) =>
      site === AMAZON_US && /^\/stores\//i.test(URL.parse(url, site.origin)?.pathname ?? "")
        ? "browser"
        : "http",
    pageIdentity: (page) => ({
      listingId: pageAsin(productRoot(amazonDocument(page.html))),
      variantId: null,
    }),
    parseProduct: (page) => parseAmazonProduct(page, site),
    nonSupplementCategories: NON_SUPPLEMENT_CATEGORIES,
    externalId: (parsed) => parsed.identity.listingId,
    productFamily: (parsed) =>
      amazonProductFamily(parsed.rendered.family, parsed.identity.listingId, site),
    planning: planning(site),
  };
  return adapter;
}

export const amazonAdapter = amazonSiteAdapter(AMAZON_US);
export const amazonInAdapter = amazonSiteAdapter(AMAZON_IN);
