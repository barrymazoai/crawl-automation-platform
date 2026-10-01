import type { ProductAddress } from "@crawl-automation/channels-core";
import { costcoErrors } from "./errors.js";

export const COSTCO_ORIGIN = "https://www.costco.com";
const PRODUCT = /^\/([a-z0-9-]+)\.product\.(\d{1,16})\.html$/i;
const CANONICAL = /^\/p\/-\/(?:([a-z0-9-]+)\/)?(\d{1,16})\/?$/i;
const CATEGORY = /^\/[a-z0-9-]+\.html$/i;

function costcoUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw, COSTCO_ORIGIN);
  } catch (cause) {
    throw costcoErrors.create("COSTCO.URL", { cause });
  }
  if (url.origin !== COSTCO_ORIGIN || url.username || url.password) {
    throw costcoErrors.create("COSTCO.URL");
  }
  return url;
}

/** Online ID, never the separate warehouse item number in JSON-LD sku. */
export function costcoProductAddress(raw: string): ProductAddress {
  const url = costcoUrl(raw);
  const match = PRODUCT.exec(url.pathname) ?? CANONICAL.exec(url.pathname);
  const listingId = match?.[2];
  if (!listingId) {
    throw costcoErrors.create("COSTCO.URL", { details: { path: url.pathname } });
  }
  const path = match[1] ? `/${match[1]}.product.${listingId}.html` : `/p/-/${listingId}`;
  return { url: `${COSTCO_ORIGIN}${path}`, listingId, variantId: null };
}

export function costcoProductUrl(listingId: string): string {
  return costcoProductAddress(`${COSTCO_ORIGIN}/p/-/${listingId}`).url;
}

/** Each (brand, category) is a distinct source; no fixed category inventory is assumed. */
export function costcoBrandSearchUrl(input: { category: string; brand: string }): string {
  const path = `/${input.category.replace(/^\//, "").replace(/\.html$/, "")}.html`;
  const brand = input.brand.trim();
  if (
    !CATEGORY.test(path) ||
    !brand ||
    brand.includes("|") ||
    [...brand].some((letter) => letter.charCodeAt(0) < 32)
  ) {
    throw costcoErrors.create("COSTCO.URL");
  }
  return `${COSTCO_ORIGIN}${path}?refinement=${encodeURIComponent(`brands=${brand}`)}`;
}

export function costcoBrandSourceUrl(raw: string): string {
  const url = costcoUrl(raw);
  const refinements = url.searchParams.getAll("refinement");
  const filter = /^brands=(.+)$/.exec(refinements[0] ?? "");
  if (!CATEGORY.test(url.pathname) || refinements.length !== 1 || !filter?.[1]) {
    throw costcoErrors.create("COSTCO.URL");
  }
  return costcoBrandSearchUrl({ category: url.pathname, brand: filter[1] });
}
