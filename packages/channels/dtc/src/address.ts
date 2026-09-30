import { channelErrors, type ProductAddress } from "@crawl-automation/channels-core";
import type { DtcSitePolicy } from "./site-policy.js";
import { dtcIdentityKey } from "./identity.js";
import { dtcBrandSource } from "./brand-source.js";

export function siteForUrl(raw: string, sites: readonly DtcSitePolicy[]): DtcSitePolicy {
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw channelErrors.create("CHANNEL.URL_REJECTED", { cause });
  }
  const site = sites.find((candidate) => candidate.origins.includes(url.origin));
  if (!site || url.protocol !== "https:" || url.username || url.password || url.port) {
    throw channelErrors.create("CHANNEL.URL_REJECTED", { details: { url: raw } });
  }
  return site;
}

/** URL identity is site + canonical path; the parsed identity separately retains the platform's product ID. */
export function dtcProductAddress(raw: string, sites: readonly DtcSitePolicy[]): ProductAddress {
  const site = siteForUrl(raw, sites);
  const url = new URL(raw);
  if (
    !new RegExp(site.productPath.source, site.productPath.flags.replace(/[gy]/g, "")).test(
      url.pathname,
    )
  ) {
    throw channelErrors.create("CHANNEL.URL_REJECTED", { details: { url: raw } });
  }
  const variantId = url.searchParams.get("variant") ?? url.searchParams.get("variation_id");
  const key = url.searchParams.has("variation_id") ? "variation_id" : "variant";
  const attributes =
    site.platform === "woocommerce"
      ? [...url.searchParams].filter(([name]) => name.startsWith("attribute_"))
      : [];
  url.pathname = url.pathname
    .replace(/^\/collections\/[^/]+\/products\//, "/products/")
    .replace(/\/$/, "");
  url.hash = "";
  url.search = "";
  if (variantId) {
    url.searchParams.set(key, variantId);
  }
  for (const [name, value] of attributes) {
    url.searchParams.set(name, value);
  }
  return { url: url.href, listingId: dtcIdentityKey(site.siteKey, url.pathname), variantId };
}

export function catalogStartUrl(raw: string, site: DtcSitePolicy): string {
  const source = dtcBrandSource(raw, [site]);
  return catalogUrl(raw, site, source.catalogUrl);
}

/** A browser brand scan starts at exactly the configured catalog entry. */
export function dtcBrandSourceUrl(raw: string, sites: readonly DtcSitePolicy[]): string {
  return catalogStartUrl(raw, siteForUrl(raw, sites));
}

export function catalogUrl(
  raw: string,
  site: DtcSitePolicy,
  sourceUrl: string | null = site.catalogUrl,
): string {
  siteForUrl(raw, [site]);
  if (!sourceUrl) {
    throw channelErrors.create("CHANNEL.URL_REJECTED");
  }
  const url = new URL(raw);
  const catalog = new URL(dtcBrandSource(sourceUrl, [site]).catalogUrl);
  const basePath = catalog.pathname.replace(/\/$/, "");
  const path = url.pathname.replace(/\/page\/\d+\/?$/, "").replace(/\/$/, "");
  const changedFilter = [...catalog.searchParams].some(
    ([name, value]) => url.searchParams.get(name) !== value,
  );
  if (url.origin !== catalog.origin || path !== basePath || changedFilter) {
    throw channelErrors.create("CHANNEL.URL_REJECTED", { details: { url: raw } });
  }
  url.hash = "";
  return url.href;
}
