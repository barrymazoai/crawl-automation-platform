import { channelErrors, type ProductAddress } from "@crawl-automation/channels-core";

export const AMAZON_ORIGIN = "https://www.amazon.com";
export const isAsin = (value: string): boolean => /^[A-Z0-9]{10}$/.test(value);

function ownSite(url: URL): boolean {
  return (
    /^(?:(?:www|smile|m)\.)?amazon\.com$/.test(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port &&
    ["https:", "http:"].includes(url.protocol)
  );
}

/** Canonical URL for an ASIN shared by another channel. */
export function amazonProductUrl(asin: string): string {
  const listingId = asin.toUpperCase();
  if (!isAsin(listingId)) {
    throw channelErrors.create("CHANNEL.URL_REJECTED");
  }
  return `${AMAZON_ORIGIN}/dp/${listingId}`;
}

/** US product addresses, including slugs, locale prefixes, mobile and legacy /gp forms. */
export function amazonProductAddress(raw: string): ProductAddress {
  const url = URL.parse(raw, AMAZON_ORIGIN);
  const path = url?.pathname.match(
    /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([a-z0-9]{10})(?:\/|$)/i,
  );
  const asin = path?.[1]?.toUpperCase();
  if (!url || !ownSite(url) || !asin) {
    throw channelErrors.create("CHANNEL.URL_REJECTED");
  }
  return { url: amazonProductUrl(asin), listingId: asin, variantId: null };
}
