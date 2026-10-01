import { brandScanErrors, type BrandScanReader, type ListingPage } from "./brand-scan.js";

export interface DrawnListing {
  page: ListingPage;
  soldHere: boolean;
}

export interface BrowserListingReaderOptions {
  sourceUrl(raw: string): string;
  maxBytes: number;
  parse(html: string, observedItems?: readonly { html: string }[]): DrawnListing;
}

/** Browser listings require retained scroll proof, never an HTTP reader's page count. */
export class BrowserListingReader implements BrandScanReader {
  readonly answer = "html";
  readonly maxPages = 1;
  readonly sourceUrl: (raw: string) => string;
  readonly maxBytes: number;

  constructor(private readonly reader: BrowserListingReaderOptions) {
    this.sourceUrl = reader.sourceUrl;
    this.maxBytes = reader.maxBytes;
  }

  pageUrl(source: string, page: number): string {
    if (page !== 1) {
      throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
    }
    return this.sourceUrl(source);
  }

  parsePage(input: Parameters<BrandScanReader["parsePage"]>[0]) {
    const listing = this.reader.parse(input.body);
    return { ...listing.page, soldHere: listing.soldHere };
  }

  complete(): boolean {
    return false;
  }
}
