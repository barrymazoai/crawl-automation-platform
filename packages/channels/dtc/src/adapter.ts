import {
  completeFacts,
  platformPageErrors,
  type ChannelAdapter,
  type FetchedPage,
  type ParsedProduct,
  type ProductIdentity,
} from "@crawl-automation/channels-core";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { dtcBrandSourceUrl, dtcProductAddress, siteForUrl } from "./address.js";
import { dtcEvidence, type DtcRendered } from "./evidence.js";
import { dtcPageIdentity, readDtcProduct } from "./product.js";
import { DTC_PAGE_LIMITS, DTC_SITES, type DtcSitePolicy } from "./site-policy.js";

function readProjection(
  projection: unknown,
  expected: { url: string; owner: ProductIdentity },
  sites: readonly DtcSitePolicy[],
) {
  const evidence = ChannelProductEvidenceSchema.parse(projection);
  const address = dtcProductAddress(expected.url, sites);
  const actual = dtcProductAddress(evidence.url, sites);
  const site = siteForUrl(expected.url, sites);
  if (
    evidence.channel !== "dtc" ||
    evidence.listingId !== expected.owner.listingId ||
    evidence.variantId !== expected.owner.variantId ||
    actual.listingId !== address.listingId ||
    evidence.brandRaw !== site.siteKey
  ) {
    throw platformPageErrors.create("DTC.IDENTITY_CONFLICT");
  }
  const selected = evidence.factsCandidates.find((entry) => entry.scope === "selected-product");
  return { evidence, facts: completeFacts(selected?.html ?? null) };
}

function parsedProduct(
  page: FetchedPage,
  sites: readonly DtcSitePolicy[],
): ParsedProduct<DtcRendered> {
  const site = siteForUrl(page.url, sites);
  const product = readDtcProduct(page, sites);
  const evidence = dtcEvidence(product, site);
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
    },
    evidence,
    commerce: {
      ...product.commerce,
      context: [...product.commerce.context, `dtc-site:${site.siteKey}`],
    },
    variants: product.variants.map((variant) => dtcProductAddress(variant.url, sites)),
    facts,
  };
}

/** One registry entry for all configured DTC sites. BrowserPages/Ego is the only capture path. */
export function createDtcAdapter(
  sites: readonly DtcSitePolicy[] = DTC_SITES,
): ChannelAdapter<DtcRendered> {
  return {
    id: "dtc",
    captureModes: ["browser"],
    scanCapture: (url) => {
      dtcBrandSourceUrl(url, sites);
      return "browser";
    },
    httpPolicy: {
      origins: [...new Set(sites.flatMap((site) => site.origins))],
      ...DTC_PAGE_LIMITS,
    },
    fileOrigins: [...new Set(sites.flatMap((site) => site.imageOrigins))],
    productAddress: (url) => dtcProductAddress(url, sites),
    pageIdentity: (page) => dtcPageIdentity(page, sites),
    parseProduct: (page) => parsedProduct(page, sites),
    externalId: (parsed) => parsed.identity.listingId,
    planning: {
      channel: "dtc",
      parserVersion: "dtc-rendered/1",
      projectionModule: "dtc.browser-projection",
      projection: (rendered) => rendered.evidence,
      read: (projection, url, owner) => readProjection(projection, { url, owner }, sites),
    },
  };
}

export const dtcAdapter = createDtcAdapter();
