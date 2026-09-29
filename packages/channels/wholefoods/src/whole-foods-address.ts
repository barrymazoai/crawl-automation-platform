import type { ProductAddress } from "@crawl-automation/channels-core";
import { wholeFoodsErrors } from "./whole-foods-errors.js";

export const WHOLE_FOODS_ORIGIN = "https://www.wholefoodsmarket.com";

/** `/grocery/product/<slug>-<asin>`: the product's Amazon ASIN ends the path. */
const PRODUCT_PATH = /^\/grocery\/product\/([a-z0-9-]+?)-(b0[a-z0-9]{8})$/i;
const BRAND_ID = /^\d{1,12}$/;

function wholeFoodsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw, WHOLE_FOODS_ORIGIN);
  } catch (error) {
    throw wholeFoodsErrors.create("WHOLEFOODS.URL", { cause: error });
  }
  if (url.origin !== WHOLE_FOODS_ORIGIN) {
    throw wholeFoodsErrors.create("WHOLEFOODS.URL", { details: { origin: url.origin } });
  }
  return url;
}

/**
 * A Whole Foods product address. Its listing ID is the ASIN, the same product ID Amazon uses (checked 2026-09-28:
 * same product, same images), which is how its formula is found; the page itself is its own listing for metrics.
 */
export function wholeFoodsProductAddress(raw: string): ProductAddress {
  const url = wholeFoodsUrl(raw);
  const match = PRODUCT_PATH.exec(url.pathname);
  const [, slug, asin] = match ?? [];
  if (!slug || !asin) {
    throw wholeFoodsErrors.create("WHOLEFOODS.URL", { details: { path: url.pathname } });
  }
  const listingId = asin.toUpperCase();
  const path = `/grocery/product/${slug}-${asin.toLowerCase()}`;
  return { url: `${WHOLE_FOODS_ORIGIN}${path}`, listingId, variantId: null };
}

/** A brand as the Amazon brand filter knows it: its name and its `p_123` brand ID. */
export interface AmazonBrand {
  name: string;
  amazonBrandId: string;
}

/** The brand's search page, filtered by its Amazon brand ID: `/grocery/search?k=<name>&rh=p_123:<id>`. */
export function wholeFoodsBrandSearchUrl(brand: AmazonBrand): string {
  if (!BRAND_ID.test(brand.amazonBrandId) || !brand.name.trim()) {
    throw wholeFoodsErrors.create("WHOLEFOODS.URL", { details: { brand: brand.amazonBrandId } });
  }
  const query = new URLSearchParams({ k: brand.name.trim(), rh: `p_123:${brand.amazonBrandId}` });
  return `${WHOLE_FOODS_ORIGIN}/grocery/search?${query.toString()}`;
}

/** A brand source URL, normalised; refuses anything that is not a brand-filtered Whole Foods search. */
export function wholeFoodsBrandSourceUrl(raw: string): string {
  const url = wholeFoodsUrl(raw);
  const name = url.searchParams.get("k") ?? "";
  const filter = /^p_123:(\d{1,12})$/.exec(url.searchParams.get("rh") ?? "");
  if (url.pathname !== "/grocery/search" || !filter?.[1]) {
    throw wholeFoodsErrors.create("WHOLEFOODS.URL", { details: { path: url.pathname } });
  }
  return wholeFoodsBrandSearchUrl({ name, amazonBrandId: filter[1] });
}
