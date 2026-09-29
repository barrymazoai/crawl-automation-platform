import type { ProductAddress } from "@crawl-automation/channels-core";
import { defineErrors } from "@crawl-automation/platform";

export const GNC_ORIGIN = "https://www.gnc.com";

/** Errors of the GNC adapter itself (the page parser raises its own `GNC.*` codes). */
export const gncErrors = defineErrors({
  "GNC.URL_REJECTED": { category: "SOURCE", message: "The address is not a GNC product page." },
  "GNC.FAMILY_PAGE": {
    category: "SOURCE",
    message: "A family page lists several products; its member SKUs are captured instead.",
  },
});

/** A product's page ID: a 6-digit SKU, or a family ID such as `GNCTotalLeanLeanShake12Pack`. */
const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * A GNC product URL: `/<category>/<id>.html` on www.gnc.com. The listing ID is the page ID (the 6-digit SKU, or a
 * family ID for a family page); GNC gives each size and flavour its own SKU page, so there is no variant ID.
 */
export function gncProductAddress(raw: string): ProductAddress {
  let url: URL;
  try {
    url = new URL(raw, GNC_ORIGIN);
  } catch (error) {
    throw gncErrors.create("GNC.URL_REJECTED", { cause: error });
  }
  const id = url.pathname.match(/\/([^/]+)\.html$/)?.[1] ?? "";
  const ownSite = url.origin === GNC_ORIGIN || url.origin === "https://gnc.com";
  const store = /demandware\.store|\/search\b/i.test(url.pathname);
  if (!ownSite || url.username || url.password || store || !PAGE_ID.test(id)) {
    throw gncErrors.create("GNC.URL_REJECTED", { details: { url: raw } });
  }
  return { url: `${GNC_ORIGIN}${url.pathname}`, listingId: id, variantId: null };
}

/** Whether a page ID is a single product's SKU (a family page lists several SKUs). */
export const isSku = (listingId: string) => /^\d{6}$/.test(listingId);
