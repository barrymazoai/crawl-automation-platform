import { brandScanErrors } from "@crawl-automation/channels-core";
import { amazonBrandSearch } from "./brand-scan-address.js";
import { amazonDocument, textOf, type AmazonDocument } from "./dom.js";
import type { AmazonSite } from "./site.js";

/**
 * KAN-243 (owner 2026-11-08): the brands whose amazon.com source is a Store page carry no numeric brand ID, so their
 * ID is looked up on the storefront itself: a keyword search in its supplement department lists the brands it found
 * in the left-hand Brands filter (amazon.in, Redcon1: `<li id="p_123/585714">` labelled "Redcon1", beside
 * "Carbamide Forte"). Only that filter is read, never product titles.
 */
export function amazonBrandLookupUrl(name: string, site: AmazonSite): string {
  const keyword = searchName(name);
  if (!keyword) {
    throw brandScanErrors.create("BRAND_SCAN.URL");
  }
  const url = new URL("/s", site.origin);
  url.searchParams.set("k", keyword);
  url.searchParams.set("i", site.searchAlias);
  url.searchParams.set("rh", `n:${site.supplementNode}`);
  url.searchParams.set("s", site.scanSort);
  return url.href;
}

/**
 * The brand search for `name` on this storefront when its Brands filter names exactly one brand the same way (case,
 * trademark marks, `&`/"and" and punctuation aside); null when the filter is missing or names none or several. A page
 * without search results is a verification page or another answer, never "not sold".
 */
export function amazonBrandSearchFromLookup(
  html: string,
  name: string,
  site: AmazonSite,
): string | null {
  const document = amazonDocument(html);
  if (!document.querySelector("div.s-main-slot")) {
    throw brandScanErrors.create(
      /Continue shopping|Enter the characters you see below/i.test(textOf(document.body))
        ? "BRAND_SCAN.ACCESS_CHALLENGE"
        : "BRAND_SCAN.NOT_HTML",
    );
  }
  const ids = brandIds(document, brandKey(name));
  const [id] = ids;
  return ids.size === 1 && id ? amazonBrandSearch(searchName(name), id, site) : null;
}

/** The numeric IDs of the Brands filter entries labelled with this key. */
function brandIds(document: AmazonDocument, wanted: string): Set<string> {
  const ids = new Set<string>();
  for (const item of document.querySelectorAll('#brandsRefinements li[id^="p_123/"]')) {
    const id = /^p_123\/(\d{1,12})$/.exec(item.getAttribute("id") ?? "")?.[1];
    if (
      id &&
      wanted &&
      brandKey(textOf(item.querySelector("span.a-size-base.a-color-base"))) === wanted
    ) {
      ids.add(id);
    }
  }
  return ids;
}

/** The brand name as a shopper types it: trademark marks dropped. */
const searchName = (name: string) => name.replace(/[®™©]/g, "").replace(/\s+/g, " ").trim();

const brandKey = (name: string) =>
  searchName(name)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]/gu, "");
