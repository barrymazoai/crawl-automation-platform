import type { ChannelRegistry, ListedProduct } from "@crawl-automation/channels-core";
import { appErrors } from "../errors.js";
import type { BrowserBrandScanners, ListingPageReader } from "./ports.js";
import { readBrandListing, type BrandListing } from "./scan-listing.js";
import { BROWSER_SCAN_CHANNELS, type ScanChannel, type ScanRecord } from "./scan-model.js";

/** Everything that can read a brand listing: adapters' ScraperAPI readers, and the configured browser scanners. */
export interface ScanReaders {
  registry: ChannelRegistry;
  pages: ListingPageReader;
  browsers: BrowserBrandScanners;
}

const isBrowserChannel = (channel: ScanChannel) => BROWSER_SCAN_CHANNELS.includes(channel);

function browserScanner(readers: Pick<ScanReaders, "browsers">, channel: ScanChannel) {
  const scanner = readers.browsers[channel];
  if (!scanner) {
    throw appErrors.create("BRAND_SCAN.BROWSER_NOT_CONFIGURED", { details: { channel } });
  }
  return scanner;
}

function adapterReader(readers: Pick<ScanReaders, "registry">, channel: ScanChannel) {
  const known = readers.registry.channels().includes(channel);
  const reader = known ? readers.registry.get(channel).brandScan : undefined;
  if (!reader) {
    throw appErrors.create("BRAND_SCAN.CHANNEL_UNSUPPORTED", { details: { channel } });
  }
  return reader;
}

/** How a channel's brand source URLs are normalised; refuses channels that cannot be scanned here. */
export function sourceUrlOf(
  readers: Pick<ScanReaders, "registry" | "browsers">,
  channel: ScanChannel,
): (url: string) => string {
  if (isBrowserChannel(channel)) {
    const scanner = browserScanner(readers, channel);
    return (url) => scanner.sourceUrl(url);
  }
  const reader = adapterReader(readers, channel);
  return (url) => reader.sourceUrl(url);
}

/** A browser scan's pages as a listing; a list not scrolled to its end, or with no results, is never full. */
async function browserListing(
  readers: ScanReaders,
  scan: ScanRecord,
  signal: AbortSignal,
): Promise<BrandListing> {
  const scanner = browserScanner(readers, scan.source.channel as ScanChannel);
  const found = await scanner.scan({ scanId: scan.scanId, sourceUrl: scan.source.url }, signal);
  const products = new Map<string, ListedProduct>();
  for (const product of found.pages.flatMap((page) => page.products)) {
    products.set(`${product.listingId}\u0000${product.variantId ?? ""}`, product);
  }
  return {
    pages: found.pages,
    products: [...products.values()],
    families: 0,
    unresolvedFamilies: 0,
    credits: 0,
    full: found.complete && found.soldHere,
  };
}

/** The brand's listing, read the way its channel is read. */
export async function readListing(
  readers: ScanReaders,
  scan: ScanRecord,
  signal: AbortSignal,
): Promise<BrandListing> {
  const channel = scan.source.channel as ScanChannel;
  if (isBrowserChannel(channel)) {
    return browserListing(readers, scan, signal);
  }
  const adapter = readers.registry.get(channel);
  const reader = adapterReader(readers, channel);
  return readBrandListing({ scan, adapter, reader, pages: readers.pages }, signal);
}
