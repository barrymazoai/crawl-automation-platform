import {
  brandScanErrors,
  type BrandScanReader,
  type ChannelAdapter,
  type ChannelId,
  type ChannelRegistry,
  type ListedProduct,
  type ListingPage,
} from "@crawl-automation/channels-core";
import type { BrowserBrandScanners, ListingPageReader } from "./ports.js";
import { BROWSER_SCAN_CHANNELS, type ScanChannel, type ScanRecord } from "./scan-model.js";
import { appErrors } from "../errors.js";
import { assertScanReadable } from "./scan-availability.js";

/** Everything that can read a brand listing: adapters' ScraperAPI readers, and the configured browser scanners. */
export interface ScanReaders {
  registry: ChannelRegistry;
  pages: ListingPageReader;
  browsers: BrowserBrandScanners;
}

/** Everything one brand's listing showed: its pages, its products (families expanded) and what it cost. */
export interface BrandListing {
  pages: ListingPage[];
  products: ListedProduct[];
  families: number;
  unresolvedFamilies: number;
  credits: number;
  /** The reader proved every product was listed, and every family's members were read. */
  full: boolean;
  /** A reader explicitly reported a capped listing. */
  capped?: boolean;
}

interface ListingWork {
  scan: ScanRecord;
  adapter: ChannelAdapter;
  reader: BrandScanReader;
  pages: ListingPageReader;
}

/** Select by source before normalisation: Amazon search and Store sources share a channel. */
function sourceReader(
  readers: Pick<ScanReaders, "registry" | "browsers">,
  channel: ScanChannel,
  url: string,
) {
  const adapter = readers.registry.channels().includes(channel)
    ? readers.registry.get(channel)
    : undefined;
  const capture = adapter
    ? (adapter.scanCapture?.(url) ?? "http")
    : BROWSER_SCAN_CHANNELS.includes(channel)
      ? "browser"
      : "http";
  if (capture === "browser") {
    const reader = readers.browsers[channel];
    if (!reader) {
      throw appErrors.create("BRAND_SCAN.BROWSER_NOT_CONFIGURED", { details: { channel } });
    }
    return { capture, reader } as const;
  }
  if (!adapter?.brandScan) {
    throw appErrors.create("BRAND_SCAN.CHANNEL_UNSUPPORTED", { details: { channel } });
  }
  return { capture, adapter, reader: adapter.brandScan } as const;
}

/** Normalise each source with the same reader the runner will use. */
export function sourceUrlOf(
  readers: Pick<ScanReaders, "registry" | "browsers">,
  channel: ScanChannel,
): (url: string) => string {
  assertScanReadable(readers, channel);
  return (url) => sourceReader(readers, channel, url).reader.sourceUrl(url);
}

/** Read this source over HTTP or through its configured browser workflow. */
export async function readListing(
  readers: ScanReaders,
  scan: ScanRecord,
  signal: AbortSignal,
): Promise<BrandListing> {
  const selected = sourceReader(readers, scan.source.channel as ScanChannel, scan.source.url);
  const url = selected.reader.sourceUrl(scan.source.url);
  if (selected.capture === "http") {
    return readBrandListing(
      { scan, adapter: selected.adapter, reader: selected.reader, pages: readers.pages },
      signal,
    );
  }
  const found = await selected.reader.scan({ scanId: scan.scanId, sourceUrl: url }, signal);
  const products = found.pages.flatMap((page) => page.products);
  const unique = new Map(
    products.map((item) => [`${item.listingId}\u0000${item.variantId ?? ""}`, item]),
  );
  return {
    pages: found.pages,
    products: [...unique.values()],
    families: 0,
    unresolvedFamilies: 0,
    credits: 0,
    full: found.complete && found.soldHere,
  };
}

/** Reads the brand's listing pages in order until the listing ends; more pages than the reader allows is a limit. */
async function readPages(work: ListingWork, signal: AbortSignal) {
  const { scan, reader } = work;
  const pages: ListingPage[] = [];
  let credits = 0;
  for (let page = 1; ; page++) {
    if (page > reader.maxPages) {
      throw brandScanErrors.create("BRAND_SCAN.PAGE_LIMIT", {
        details: { maxPages: reader.maxPages },
      });
    }
    const url = reader.pageUrl(scan.source.url, page);
    const read = await work.pages.read(
      {
        ...target(work),
        url,
        label: `page-${page}`,
        answer: reader.answer,
        maxBytes: reader.maxBytes,
      },
      signal,
    );
    credits += read.creditCost ?? 0;
    const listed = reader.parsePage({ body: read.body, url, page });
    pages.push(listed);
    if (listed.nextPage === null || listed.products.length === 0) {
      return { pages, credits };
    }
  }
}

function target(work: ListingWork) {
  return {
    scanId: work.scan.scanId,
    channel: work.adapter.id as ChannelId,
    origins: work.adapter.httpPolicy.origins,
  };
}

/** A family's members, read from the family's own (archived) page. */
async function familyMembers(work: ListingWork, family: ListedProduct, signal: AbortSignal) {
  const { reader } = work;
  if (!reader.familyMembers) {
    return { members: [] as ListedProduct[], credits: 0 };
  }
  const read = await work.pages.read(
    {
      ...target(work),
      url: family.url,
      label: `family-${family.listingId}`,
      answer: "html",
      maxBytes: work.adapter.httpPolicy.maxBytes,
    },
    signal,
  );
  const page = { url: family.url, html: read.body, capturedAt: new Date().toISOString() };
  return { members: reader.familyMembers(page), credits: read.creditCost ?? 0 };
}

/**
 * The brand's full product list: every listing page (archived before it is read), then each family expanded into
 * its member products. A family whose page names no members makes the scan not full: its members may exist.
 */
export async function readBrandListing(
  work: ListingWork,
  signal: AbortSignal,
): Promise<BrandListing> {
  const { pages, credits: pageCredits } = await readPages(work, signal);
  const listed = pages.flatMap((page) => page.products);
  const families = listed.filter((product) => product.kind === "family");
  const products = new Map<string, ListedProduct>();
  for (const product of listed.filter((item) => item.kind === "product")) {
    products.set(`${product.listingId}\u0000${product.variantId ?? ""}`, product);
  }
  let credits = pageCredits;
  let unresolved = 0;
  for (const family of families) {
    const { members, credits: familyCredits } = await familyMembers(work, family, signal);
    credits += familyCredits;
    unresolved += members.length === 0 ? 1 : 0;
    for (const member of members) {
      products.set(`${member.listingId}\u0000${member.variantId ?? ""}`, member);
    }
  }
  const capped = pages.some((page) => "capped" in page && page.capped === true);
  const full = !capped && work.reader.complete(pages) && unresolved === 0;
  const productList = [...products.values()];
  return {
    pages,
    products: productList,
    families: families.length,
    unresolvedFamilies: unresolved,
    credits,
    full,
    capped,
  };
}
