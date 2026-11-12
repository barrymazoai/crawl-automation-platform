import {
  brandScanErrors,
  type BrandScanReader,
  type ListedProduct,
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
import { AMAZON_US, type AmazonSite } from "./site.js";

export interface AmazonListingPage extends ListingPage {
  capped: boolean;
}

function checkBrandFilter(document: AmazonDocument, url: string, site: AmazonSite): void {
  const filter = amazonScanBrandFilter(url, site);
  // The 19 /s?srs= brand pages do not have the search page's selected checkbox.
  if (new URL(url).searchParams.has("srs")) {
    return;
  }
  const facet = document.getElementById(filter.replace(":", "/"));
  if (facet?.querySelector('input[type="checkbox"][checked]')) {
    return;
  }
  if (facet || document.getElementById("brandsRefinements") || !formsKeepFilters(document, url)) {
    throw amazonErrors.create("AMAZON.SCAN_FILTER_LOST");
  }
}

/**
 * KAN-243 2026-11-12 (amazon.de, 66 of 966 "filter lost" scans): a filtered result page may print no Brands panel at
 * all (Optimum Nutrition: 21 results, every card the brand; Allergy Research Group's last page 25–27 of 27), so the
 * filters Amazon applied are read from the page's own search forms, whose hidden `rh` field carries them
 * (`n:64374031,p_123:250393`). A storefront that drops an unknown brand ID ("No results for Luma Nutrition in Health &
 * Personal Care", results from All Departments) prints no such field, and a panel without the brand checked still
 * fails.
 */
function formsKeepFilters(document: AmazonDocument, url: string): boolean {
  const requested = filterSet(new URL(url).searchParams.get("rh"));
  const applied = [...document.querySelectorAll('input[type="hidden"][name="rh"]')].map((input) =>
    filterSet(input.getAttribute("value")),
  );
  return applied.length > 0 && applied.every((filters) => filters === requested);
}

const filterSet = (rh: string | null) => (rh ?? "").split(",").filter(Boolean).sort().join(",");

type PageInput = { body: string; url: string; page: number };

function nextPage(document: AmazonDocument, input: PageInput, site: AmazonSite): number | null {
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
    amazonScanSourceUrl(url.href, site) !== amazonScanSourceUrl(input.url, site)
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

function parsePage(input: PageInput, site: AmazonSite): AmazonListingPage {
  amazonScanPageUrl(input.url, input.page, site);
  const document = amazonDocument(input.body);
  const grid = document.querySelector("div.s-main-slot");
  if (!grid) {
    throw amazonErrors.create("AMAZON.SCAN_UNVERIFIED");
  }
  const cards = amazonOrganicCards(grid);
  const products = cards.map((card) => amazonCardProduct(card, site));
  if (cards.length) {
    checkBrandFilter(document, input.url, site);
  } else if (/Continue shopping|Enter the characters you see below/i.test(textOf(document.body))) {
    throw brandScanErrors.create("BRAND_SCAN.ACCESS_CHALLENGE");
  }
  const next = cards.length ? nextPage(document, input, site) : null;
  const info = textOf(document.querySelector('[data-component-type="s-result-info-bar"]'));
  const listed = [...new Map(products.map((product) => [product.listingId, product])).values()];
  return {
    ...keptPage({ listed, cards: cards.length, next, info, page: input.page }, site),
    statedTotal: statedTotal(info),
  };
}

/**
 * The products the storefront keeps from this page and whether the scan stops here capped: at its last page with
 * more to read, or with products left out (amazon.in keeps a page's first fifty).
 */
function keptPage(
  at: { listed: ListedProduct[]; cards: number; next: number | null; info: string; page: number },
  site: AmazonSite,
) {
  const kept = site.scanProducts === null ? at.listed : at.listed.slice(0, site.scanProducts);
  const trimmed = kept.length < at.listed.length;
  const last = at.page === site.scanPages;
  const more =
    at.next !== null || (site.scanPages === AMAZON_SCAN_MAX_PAGES && fullLastPage(at.info));
  return {
    products: kept,
    cards: at.cards,
    nextPage: last || trimmed ? null : at.next,
    capped: trimmed || (last && at.cards > 0 && more),
  };
}

function siteReader(site: AmazonSite) {
  return {
    sourceUrl: (url: string) => amazonScanSourceUrl(url, site),
    pageUrl: (url: string, page: number) => amazonScanPageUrl(url, page, site),
    answer: "html",
    maxPages: site.scanPages,
    maxBytes: AMAZON_MAX_BYTES,
    parsePage: (input: PageInput) => parsePage(input, site),
    complete: (pages: readonly ListingPage[]) => {
      const last = pages.at(-1);
      return !!last && last.nextPage === null && "capped" in last && last.capped === false;
    },
  } satisfies BrandScanReader;
}

const readers = new Map<AmazonSite, ReturnType<typeof siteReader>>();

/** Seven-page ScraperAPI search scan of one storefront, in its scan order (US newest first); Store pages belong to the browser scanner. */
export function amazonSiteBrandScan(site: AmazonSite) {
  const reader = readers.get(site) ?? siteReader(site);
  readers.set(site, reader);
  return reader;
}

export const amazonBrandScan = amazonSiteBrandScan(AMAZON_US);
