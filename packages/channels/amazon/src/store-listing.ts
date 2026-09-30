import {
  brandScanErrors,
  type BrandScanReader,
  type ListingPage,
} from "@crawl-automation/channels-core";
import { AMAZON_ORIGIN, isAsin } from "./address.js";
import { AMAZON_MAX_BYTES, amazonDocument } from "./dom.js";
import { amazonErrors } from "./errors.js";
import { amazonStoreAddress, amazonStoreSourceUrl } from "./store-address.js";
import { inspectStoreDom, STORE_SELECTORS } from "./store-dom.js";

export interface AmazonStoreListing extends ListingPage {
  sourceUrl: string;
  navigation: string[];
  capped: boolean;
}

/** Parsing is done only after the rendered HTML and its scroll proof have been archived. */
export function parseAmazonStoreListing(body: string, url: string): AmazonStoreListing {
  const sourceUrl = amazonStoreSourceUrl(url);
  const state = inspectStoreDom(amazonDocument(body), STORE_SELECTORS);
  if (state.blocked) {
    throw brandScanErrors.create("BRAND_SCAN.ACCESS_CHALLENGE");
  }
  if (!state.ready) {
    throw amazonErrors.create("AMAZON.STORE_UNVERIFIED");
  }
  if (state.invalidTiles || state.asins.some((asin) => !isAsin(asin))) {
    throw brandScanErrors.create("BRAND_SCAN.TILE_IDENTITY");
  }
  return {
    sourceUrl,
    products: state.asins.map((listingId) => ({
      listingId,
      url: `${AMAZON_ORIGIN}/dp/${listingId}`,
      variantId: null,
      title: null,
      kind: "product",
    })),
    cards: state.asins.length,
    nextPage: null,
    statedTotal: null,
    navigation: state.navigation,
    // HTML alone cannot prove a dynamic list ended. The browser scanner attaches that proof.
    capped: true,
  };
}

/** Store HTML reader; traversal uses observed navigation, never synthesized page numbers. */
export const amazonStoreBrandScan: BrandScanReader = {
  sourceUrl: amazonStoreSourceUrl,
  pageUrl: (source, page) => {
    if (page !== 1) {
      throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
    }
    return amazonStoreAddress(source).url;
  },
  answer: "html",
  maxPages: 100,
  maxBytes: AMAZON_MAX_BYTES,
  parsePage: ({ body, url }) => parseAmazonStoreListing(body, url),
  // Only AmazonStoreBrandScan can prove that the observed navigation graph is exhausted.
  complete: () => false,
};
