import { defineErrors } from "@crawl-automation/platform";

const source = (message: string) => ({ category: "SOURCE" as const, message });

/** Errors of reading a brand's listing pages. The codes match the 09-28 scan tools' `BRAND_SCAN.*` codes. */
export const brandScanErrors = defineErrors({
  "BRAND_SCAN.URL": source("The address is not this channel's brand listing."),
  "BRAND_SCAN.ACCESS_CHALLENGE": source("The site answered with a human-verification page."),
  "BRAND_SCAN.NOT_JSON": source("The listing answer is not the expected JSON."),
  "BRAND_SCAN.NOT_HTML": source("The listing answer is not HTML."),
  "BRAND_SCAN.TILE_IDENTITY": source("A product tile has no readable product ID or link."),
  "BRAND_SCAN.PAGINATION": source("The listing's next page does not follow this one."),
  "BRAND_SCAN.COUNT_MISSING": source("The listing shows products but no brand total."),
  "BRAND_SCAN.PAGE_LIMIT": source("The brand has more listing pages than a scan reads."),
  "BRAND_SCAN.NOT_FOUND": source("The brand listing no longer exists."),
  "BRAND_SCAN.HTTP_STATUS": source("The listing answered with an unexpected status."),
  "BRAND_SCAN.ENCODING": source("The listing answer is compressed or not valid UTF-8."),
  "BRAND_SCAN.ARCHIVE_UNVERIFIED": {
    category: "ARTIFACT",
    message: "An archived listing page does not match what was written.",
  },
});
export type BrandScanErrorCode = keyof typeof brandScanErrors.codes;

/** A fetched page's text (the same shape as a product page; kept here so this file needs nothing from the adapter). */
export interface ListingPageContent {
  url: string;
  html: string;
  capturedAt: string;
}

/** One product a brand listing shows: a product page, or a family whose members are on its own page. */
export interface ListedProduct {
  url: string;
  listingId: string;
  variantId: string | null;
  title: string | null;
  kind: "product" | "family";
}

/** What one listing page shows. */
export interface ListingPage {
  /** Present when the reader can establish whether the store sells this brand. */
  soldHere?: boolean;
  products: ListedProduct[];
  /** Product tiles on this page (promotion tiles are not products). */
  cards: number;
  nextPage: number | null;
  /** The brand total the page states, when it states one. */
  statedTotal: number | null;
}

/**
 * How a channel reads retained HTTP or browser brand pages: site addresses and page shapes only.
 */
export interface BrandScanReader {
  /** Normalises a brand source URL; refuses anything that is not this channel's brand listing. */
  sourceUrl(url: string): string;
  pageUrl(sourceUrl: string, page: number): string;
  /** What a listing page answers with. */
  answer: "html" | "json";
  maxPages: number;
  /** Listing pages can be much larger than product pages (a GNC brand page is ~3 MB). */
  maxBytes: number;
  parsePage(page: { body: string; url: string; page: number }): ListingPage;
  /** Whether the pages read prove every product of the brand was listed (a full scan). */
  complete(pages: readonly ListingPage[]): boolean;
  /** A family's member products, read from the family's own page. */
  familyMembers?(page: ListingPageContent): ListedProduct[];
}
