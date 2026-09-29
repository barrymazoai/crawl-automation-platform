import { canonicalHash, text } from "./canonical.js";

/** A listing as the history keys it: by its channel site and product ID, else its URL, else unresolved. */
export interface HistoryListing {
  id: string;
  channel: string;
  site: string | null;
  externalId: string | null;
  url: string | null;
  basis: "external-id" | "url" | "unresolved";
  identity: Record<string, unknown>;
}

const TRACKING = /^utm_|^(ref|ref_|tag|linkCode|linkId|th|psc)$/u;
const AMAZON_HOST = /(^|\.)amazon\.(com|ca|co\.uk|de|fr|it|es|co\.jp|com\.au)$/u;

/** Which hosts are each channel's own site (a DTC listing is its brand's own site, any host). */
const CHANNEL_SITES: Record<string, (host: string) => boolean> = {
  amazon: (host) => AMAZON_HOST.test(host),
  gnc: (host) => host === "gnc.com",
  swanson: (host) => host === "swansonvitamins.com",
  dtc: () => true,
  costco: (host) => host === "costco.com",
  wholefoods: (host) => host === "wholefoodsmarket.com",
};

/** The page URL without its fragment, `www.`, tracking parameters and trailing slashes; null if not a web URL. */
function normalizedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return null;
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }
  return url;
}

/** The channel's own site the URL is on, or null when it is not on that channel's site. */
function channelSite(channel: string, url: URL | null): string | null {
  const host = url?.hostname;
  const belongs = CHANNEL_SITES[channel];
  return host && belongs?.(host) ? host : null;
}

/** Amazon's ASIN from a `/dp/…` or `/gp/product/…` path. */
function asinFrom(url: URL | null): string | null {
  const match = url?.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/iu);
  return match?.[1]?.toUpperCase() ?? null;
}

/** The product ID the listing is keyed by; null when it is invalid or contradicts the URL. */
function verifiedExternalId(channel: string, external: string | null, url: URL | null) {
  if (channel !== "amazon") {
    return { externalId: external, conflict: false };
  }
  const asin = asinFrom(url);
  const invalid = !!external && !/^[A-Z0-9]{10}$/iu.test(external);
  const conflict = !!asin && !!external && asin !== external.toUpperCase();
  const externalId = invalid || conflict ? null : (external?.toUpperCase() ?? asin);
  return { externalId, conflict };
}

/**
 * The history listing of a captured page. Same rules and IDs as the earlier history store, so new captures extend
 * the listings already there; Whole Foods and Costco are added as channel sites.
 */
export function identifyListing(page: {
  channel: string;
  url: string;
  externalId: string | null;
  sourceKey: string;
  dataset: string;
}): HistoryListing {
  const channel = page.channel.toLowerCase();
  const url = normalizedUrl(page.url);
  const site = channelSite(channel, url);
  const onSite = site ? url : null;
  const { externalId, conflict } = verifiedExternalId(channel, text(page.externalId), onSite);
  const basis = basisOf({ site, conflict, externalId, url });
  const identity = identityOf({ basis, channel, site, externalId, url, conflict }, page);
  const listingUrl = onSite ? onSite.toString() : null;
  return {
    id: canonicalHash(identity),
    channel,
    site,
    externalId,
    url: listingUrl,
    basis,
    identity,
  };
}

type Basis = HistoryListing["basis"];

/** Keyed by product ID when the site and ID are verified, else by URL, else unresolved. */
function basisOf(found: {
  site: string | null;
  conflict: boolean;
  externalId: string | null;
  url: URL | null;
}): Basis {
  const { site, conflict, externalId, url } = found;
  if (!site || conflict) {
    return "unresolved";
  }
  if (externalId) {
    return "external-id";
  }
  return url && url.pathname !== "/" ? "url" : "unresolved";
}

function identityOf(
  found: {
    basis: Basis;
    channel: string;
    site: string | null;
    externalId: string | null;
    url: URL | null;
    conflict: boolean;
  },
  page: { dataset: string; sourceKey: string },
): Record<string, unknown> {
  const { basis, channel, site, externalId, url, conflict } = found;
  if (basis === "external-id") {
    return { channel, site, externalId };
  }
  if (basis === "url") {
    return { channel, site, url: url?.toString() };
  }
  return unresolvedIdentity(channel, page, conflict);
}

function unresolvedIdentity(
  channel: string,
  page: { dataset: string; sourceKey: string },
  conflict: boolean,
) {
  const reason = conflict ? "external_id_url_conflict" : "no_verified_channel_anchor";
  return {
    channel,
    dataset: page.dataset,
    sourceKey: page.sourceKey,
    legacyListingId: null,
    reason,
  };
}
