import { dtcLabelCoreV2 } from "./label-core.js";
import {
  ANY_HTTPS_ORIGIN,
  completeFacts,
  channelErrors,
  type ChannelAdapter,
  type FetchedPage,
  type ParsedProduct,
} from "@crawl-automation/channels-core";
import { dtcBrandSourceUrl, dtcProductAddress, siteForUrl, siteForBrandUrl } from "./address.js";
import { dtcEvidence, type DtcRendered } from "./evidence.js";
import { dtcPageIdentity, readDtcProduct } from "./product.js";
import { DTC_PAGE_LIMITS, DTC_SITES, type DtcSitePolicy } from "./site-policy.js";
import { dtcBrandEvidence } from "./brand-evidence.js";
import {
  assertDtcBrandSource,
  dtcBrandSource,
  dtcBrandSources,
  type DtcBrandSource,
} from "./brand-source.js";
import { dtcBrandSighting } from "./brand-sighting.js";
import { dtcProjection, readDtcProjection } from "./projection.js";

export interface DtcAdapter extends ChannelAdapter<DtcRendered> {
  readonly brandSources: readonly DtcBrandSource[];
  forBrandSource(sourceUrl: string): DtcAdapter;
}

function parsedProduct(
  page: FetchedPage,
  sites: readonly DtcSitePolicy[],
  source: DtcBrandSource | null,
): ParsedProduct<DtcRendered> {
  const site = siteForUrl(page.url, sites);
  const product = readDtcProduct(page, sites);
  const brandEvidence = dtcBrandEvidence(site, product.brandRaw, source);
  const evidence = dtcEvidence(product, site, brandEvidence);
  const selected = evidence.factsCandidates.find((entry) => entry.scope === "selected-product");
  const facts = completeFacts(selected?.html ?? null);
  return {
    channel: "dtc",
    identity: { listingId: evidence.listingId, variantId: evidence.variantId },
    rendered: {
      evidence,
      facts,
      platform: product.platform,
      siteKey: site.siteKey,
      productId: product.productId,
      brandEvidence,
    },
    evidence,
    commerce: {
      ...product.commerce,
      context: [
        ...product.commerce.context,
        `dtc-site:${site.siteKey}`,
        `dtc-seller:${site.siteKey}`,
      ],
    },
    variants: product.variants.map((variant) => dtcProductAddress(variant.url, sites)),
    facts,
    ...(product.categories?.length ? { categories: product.categories } : {}),
  };
}

/**
 * Owner 2026-10-20: store filings outside supplements on DTC sites (Shopify product type and tags, JSON-LD
 * breadcrumbs). A product under one whose label step would go to Review ends as "not a supplement": the 69
 * `CHANNEL.LABEL_NO_SOURCE` attempts since 2026-10-05 were essential oils, gift cards and the like. Exact names,
 * case-insensitive; pet supplements are deliberately not listed.
 */
export const DTC_NON_SUPPLEMENT_CATEGORIES: readonly string[] = [
  "Gift Card",
  "Gift Cards",
  "Apparel",
  "Clothing",
  "Merchandise",
  "Merch",
  "Accessories",
  "Essential Oil",
  "Essential Oils",
  "Aromatherapy",
  // naturestruth.com 2026-10-21: its oils are typed by their name ("Peppermint") and tagged by use; these tags
  // name external uses only (a diffuser, a spray, a massage or topical oil), never a supplement.
  "Diffuser",
  "Aroma Spray",
  "Air Freshener",
  "Topical Oil",
  "Massage",
  "Carrier Oil",
  "Skin Care",
  "Skincare",
  "Hair Care",
  "Body Care",
  "Beauty",
  "Cosmetics",
  "Books",
  "Equipment",
  "Devices",
];

/** One registry entry for all configured DTC sites. BrowserPages/Ego is the only capture path. */
export function createDtcAdapter(
  sites: readonly DtcSitePolicy[] = DTC_SITES,
  sourceUrl?: string,
): DtcAdapter {
  const source = sourceUrl ? dtcBrandSource(sourceUrl, sites) : null;
  const scopedSites = source ? [siteForBrandUrl(source.catalogUrl, sites)] : sites;
  // Single-brand parsing keeps its original evidence/projection, even with a task-bound address policy.
  const productSource = scopedSites[0]?.kind === "multi-brand" ? source : null;
  const scope = { sites: scopedSites, source: productSource };
  return {
    id: "dtc",
    brandSources: source ? [source] : dtcBrandSources(sites),
    forBrandSource: (url) => createDtcAdapter(sites, url),
    assertBrandSource: (entry) => assertDtcBrandSource(entry, scopedSites),
    captureModes: ["browser"],
    scanCapture: (url) => {
      dtcBrandSourceUrl(url, scopedSites);
      if (source && url !== source.catalogUrl) {
        throw channelErrors.create("CHANNEL.URL_REJECTED", { details: { url } });
      }
      return "browser";
    },
    httpPolicy: {
      origins: [...new Set(scopedSites.flatMap((site) => site.origins))],
      ...DTC_PAGE_LIMITS,
    },
    // Owner 2026-10-08: DTC product images may be downloaded from any image server, no host allowlist.
    fileOrigins: [ANY_HTTPS_ORIGIN],
    productAddress: (url) => dtcProductAddress(url, scopedSites),
    pageIdentity: (page) => dtcPageIdentity(page, scopedSites),
    pageSighting: (page) => dtcBrandSighting(page, scope),
    parseProduct: (page) => parsedProduct(page, scopedSites, productSource),
    externalId: (parsed) => parsed.identity.listingId,
    nonSupplementCategories: DTC_NON_SUPPLEMENT_CATEGORIES,
    planning: dtcPlanning(scope),
  };
}

function dtcPlanning(
  scope: Parameters<typeof readDtcProjection>[2],
): NonNullable<DtcAdapter["planning"]> {
  return {
    channel: "dtc",
    parserVersion: "dtc-rendered/1",
    projectionModule: "dtc.browser-projection",
    projection: dtcProjection,
    read: (projection, url, owner) => readDtcProjection(projection, { url, owner }, scope),
    corePolicy: "dtc-label-core/2",
    labelCore: dtcLabelCoreV2,
  };
}

export const dtcAdapter = createDtcAdapter();
