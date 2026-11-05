import { channelErrors, type ProductAddress } from "@crawl-automation/channels-core";
import { AMAZON_US, type AmazonSite } from "./site.js";

export const AMAZON_ORIGIN = AMAZON_US.origin;
export const isAsin = (value: string): boolean => /^[A-Z0-9]{10}$/.test(value);

function ownSite(url: URL, site: AmazonSite): boolean {
  return (
    site.hosts.test(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port &&
    ["https:", "http:"].includes(url.protocol)
  );
}

/** Canonical URL for an ASIN shared by another channel. */
export function amazonProductUrl(asin: string, site: AmazonSite = AMAZON_US): string {
  const listingId = asin.toUpperCase();
  if (!isAsin(listingId)) {
    throw channelErrors.create("CHANNEL.URL_REJECTED");
  }
  return `${site.origin}/dp/${listingId}`;
}

/** The storefront's product addresses, including slugs, locale prefixes, mobile and legacy /gp forms. */
export function amazonProductAddress(raw: string, site: AmazonSite = AMAZON_US): ProductAddress {
  const url = URL.parse(raw, site.origin);
  const path = url?.pathname.match(
    /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([a-z0-9]{10})(?:\/|$)/i,
  );
  const asin = path?.[1]?.toUpperCase();
  if (!url || !ownSite(url, site) || !asin) {
    throw channelErrors.create("CHANNEL.URL_REJECTED");
  }
  return { url: amazonProductUrl(asin, site), listingId: asin, variantId: null };
}
