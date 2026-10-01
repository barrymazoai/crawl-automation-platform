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
  /** Stable card identities, separate from products when a card includes variations. */
  cardIds?: string[];
  /** Page position retained by readers that prove a consecutive pagination chain. */
  pageNumber?: number;
  nextPage: number | null;
  /** The brand total the page states, when it states one. */
  statedTotal: number | null;
}

/** The name selected for a listing and whether resolving it required the fallback. */
export interface ListingNameResolution {
  brandName: string;
  usedFallback: boolean;
}

export interface ResolvedListing {
  sourceUrl: string;
  /** A successful lookup can supply page 1 without another request. */
  firstPage?: ListingPage;
  nameResolution?: ListingNameResolution;
}

/** A channel chooses each next request from retained evidence; labels must be unique per scan. */
export interface ListingResolveRequest {
  request: { url: string; label: string; answer: "html" | "json"; maxBytes: number };
  parsePage(page: { body: string; url: string }): ListingResolveStep;
}

export type ListingResolveStep = ListingResolveRequest | ResolvedListing;
