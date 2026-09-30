import {
  brandScanErrors,
  type BrandScanReader,
  type ListingPage,
} from "@crawl-automation/channels-core";
import {
  AMAZON_SCAN_MAX_PAGES,
  amazonScanBrandFilter,
  amazonScanPageUrl,
  amazonScanSourceUrl,
} from "./brand-scan-address.js";
import { AMAZON_MAX_BYTES, amazonDocument, textOf, type AmazonDocument } from "./dom.js";
import { amazonErrors } from "./errors.js";
import { amazonCardProduct, amazonOrganicCards } from "./search-cards.js";

export interface AmazonListingPage extends ListingPage {
  capped: boolean;
}

function checkBrandFilter(document: AmazonDocument, url: string): void {
  const filter = amazonScanBrandFilter(url);
  // The 19 /s?srs= brand pages do not have the search page's selected checkbox.
  if (new URL(url).searchParams.has("srs")) {
    return;
  }
  const facet = document.getElementById(filter.replace(":", "/"));
  if (!facet?.querySelector('input[type="checkbox"][checked]')) {
    throw amazonErrors.create("AMAZON.SCAN_FILTER_LOST");
  }
}

function nextPage(document: AmazonDocument, input: { url: string; page: number }): number | null {
  const selected = textOf(document.querySelector(".s-pagination-selected"));
  if ((selected && Number(selected) !== input.page) || (!selected && input.page > 1)) {
    throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
  }
  const next = document.querySelector(
    'a.s-pagination-next[href]:not(.s-pagination-disabled):not([aria-disabled="true"])',
  );
  if (!next) {
    return null;
  }
  const url = URL.parse(next.getAttribute("href") ?? "", input.url);
  if (
    !url ||
    Number(url.searchParams.get("page")) !== input.page + 1 ||
    amazonScanSourceUrl(url.href) !== amazonScanSourceUrl(input.url)
  ) {
    throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
  }
  return input.page + 1;
}

/** Range positions reveal page size (24 or 48); the advertised total is never completeness proof. */
function fullLastPage(info: string): boolean {
  const range = info.match(/([\d,]+)\s*[-–]\s*([\d,]+)\s+of\b/i);
  const start = Number(range?.[1]?.replaceAll(",", ""));
  const end = Number(range?.[2]?.replaceAll(",", ""));
  const size = (start - 1) / (AMAZON_SCAN_MAX_PAGES - 1);
  // Without a usable range, a populated seventh page cannot establish exhaustion.
  return !Number.isInteger(size) || size <= 0 || end - start + 1 >= size;
}

function statedTotal(info: string): number | null {
  const total = info.match(/of\s+(?:over\s+)?([\d,]+)\s+results\b/i)?.[1];
  return total ? Number(total.replaceAll(",", "")) : null;
}

function parsePage(input: { body: string; url: string; page: number }): AmazonListingPage {
  amazonScanPageUrl(input.url, input.page);
  const document = amazonDocument(input.body);
  const grid = document.querySelector("div.s-main-slot");
  if (!grid) {
    throw amazonErrors.create("AMAZON.SCAN_UNVERIFIED");
  }
  const cards = amazonOrganicCards(grid);
  const products = cards.map(amazonCardProduct);
  if (cards.length) {
    checkBrandFilter(document, input.url);
  } else if (/Continue shopping|Enter the characters you see below/i.test(textOf(document.body))) {
    throw brandScanErrors.create("BRAND_SCAN.ACCESS_CHALLENGE");
  }
  const next = cards.length ? nextPage(document, input) : null;
  const info = textOf(document.querySelector('[data-component-type="s-result-info-bar"]'));
  const capped =
    input.page === AMAZON_SCAN_MAX_PAGES &&
    cards.length > 0 &&
    (next !== null || fullLastPage(info));
  return {
    products: [...new Map(products.map((product) => [product.listingId, product])).values()],
    cards: cards.length,
    nextPage: input.page === AMAZON_SCAN_MAX_PAGES ? null : next,
    statedTotal: statedTotal(info),
    capped,
  };
}

/** Seven-page, newest-first ScraperAPI search scan; Store pages belong to the browser scanner. */
export const amazonBrandScan = {
  sourceUrl: amazonScanSourceUrl,
  pageUrl: amazonScanPageUrl,
  answer: "html",
  maxPages: AMAZON_SCAN_MAX_PAGES,
  maxBytes: AMAZON_MAX_BYTES,
  parsePage,
  complete: (pages: readonly ListingPage[]) => {
    const last = pages.at(-1);
    return !!last && last.nextPage === null && "capped" in last && last.capped === false;
  },
} satisfies BrandScanReader;
