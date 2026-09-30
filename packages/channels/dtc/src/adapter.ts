import {
  completeFacts,
  channelErrors,
  type ChannelAdapter,
  type FetchedPage,
  type ParsedProduct,
} from "@crawl-automation/channels-core";
import { dtcBrandSourceUrl, dtcProductAddress, siteForUrl } from "./address.js";
import { dtcEvidence, type DtcRendered } from "./evidence.js";
import { dtcPageIdentity, readDtcProduct } from "./product.js";
import { DTC_PAGE_LIMITS, DTC_SITES, type DtcSitePolicy } from "./site-policy.js";
import { dtcBrandEvidence } from "./brand-evidence.js";
import { dtcBrandSource, dtcBrandSources, type DtcBrandSource } from "./brand-source.js";
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
  };
}

/** One registry entry for all configured DTC sites. BrowserPages/Ego is the only capture path. */
export function createDtcAdapter(
  sites: readonly DtcSitePolicy[] = DTC_SITES,
  sourceUrl?: string,
): DtcAdapter {
  const source = sourceUrl ? dtcBrandSource(sourceUrl, sites) : null;
  const scopedSites = source ? [siteForUrl(source.catalogUrl, sites)] : sites;
  // Single-brand parsing keeps its original evidence/projection, even with a task-bound address policy.
  const productSource = scopedSites[0]?.kind === "multi-brand" ? source : null;
  const scope = { sites: scopedSites, source: productSource };
  return {
    id: "dtc",
    brandSources: source ? [source] : dtcBrandSources(sites),
    forBrandSource: (url) => createDtcAdapter(sites, url),
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
    fileOrigins: [...new Set(scopedSites.flatMap((site) => site.imageOrigins))],
    productAddress: (url) => dtcProductAddress(url, scopedSites),
    pageIdentity: (page) => dtcPageIdentity(page, scopedSites),
    parseProduct: (page) => parsedProduct(page, scopedSites, productSource),
    externalId: (parsed) => parsed.identity.listingId,
    planning: {
      channel: "dtc",
      parserVersion: "dtc-rendered/1",
      projectionModule: "dtc.browser-projection",
      projection: dtcProjection,
      read: (projection, url, owner) => readDtcProjection(projection, { url, owner }, scope),
    },
  };
}

export const dtcAdapter = createDtcAdapter();
