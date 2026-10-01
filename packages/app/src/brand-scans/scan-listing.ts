import {
  type ChannelRegistry,
  type ChannelId,
  type ListedProduct,
} from "@crawl-automation/channels-core";
import type { BrowserBrandScanners, ListingPageReader } from "./ports.js";
import type { ScanChannel } from "./scan-model.js";
import { appErrors } from "../errors.js";
import {
  readPages,
  listingTarget,
  type ListingWork,
  type ListingScan,
} from "./http-listing-pages.js";
import { assertScanReadable } from "./scan-availability.js";

import { policyListing, readPolicyListing } from "./policy-listing.js";

export type { ListingScan } from "./http-listing-pages.js";

/** Everything that can read a brand listing: adapters' ScraperAPI readers, and the configured browser scanners. */
export interface ScanReaders {
  registry: ChannelRegistry;
  pages: ListingPageReader;
  browsers: BrowserBrandScanners;
  checkpoint?: ((scanId: string) => Promise<void>) | undefined;
  channels?: Partial<Record<ChannelId, { requestIntervalMs: number }>>;
}

export type { BrandListing } from "./scan-listing-model.js";
import type { BrandListing } from "./scan-listing-model.js";

/** Select by source before normalisation: Amazon search and Store sources share a channel. */
function sourceReader(
  readers: Pick<ScanReaders, "registry" | "browsers">,
  channel: ScanChannel,
  url: string,
) {
  const adapter = readers.registry.channels().includes(channel)
    ? readers.registry.forBrandSource(channel, url)
    : undefined;
  const capture = adapter
    ? (adapter.scanCapture?.(url) ?? "http")
    : readers.browsers[channel] !== undefined
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
  scan: ListingScan,
  signal: AbortSignal,
): Promise<BrandListing> {
  const selected = sourceReader(readers, scan.source.channel as ScanChannel, scan.source.url);
  if (selected.capture === "http") {
    await readers.checkpoint?.(scan.scanId);
    return readBrandListing(
      {
        scan,
        checkpoint: () => readers.checkpoint?.(scan.scanId) ?? Promise.resolve(),
        adapter: selected.adapter,
        reader: selected.reader,
        pages: readers.pages,
        requestIntervalMs: readers.channels?.[selected.adapter.id]?.requestIntervalMs ?? 0,
      },
      signal,
    );
  }
  const request = {
    scanId: scan.scanId,
    sourceUrl: selected.reader.sourceUrl(scan.source.url),
    sourceId: scan.source.sourceId,
  };
  // Reattach remote browser executions even after cancellation; only their worker can prove page cleanup.
  const found = await selected.reader.scan(request, signal);
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
    full: found.complete,
    soldHere: found.soldHere,
  };
}

/** A family's members, read from the family's own (archived) page. */
async function familyMembers(work: ListingWork, family: ListedProduct, signal: AbortSignal) {
  const { reader } = work;
  if (!reader.familyMembers) {
    return { members: [] as ListedProduct[], credits: 0 };
  }
  await work.checkpoint?.();
  const read = await work.pages.read(
    {
      ...listingTarget(work),
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
  const observed = await readPolicyListing(work, signal);
  return observed ? policyListing(observed) : readStandardListing(work, signal);
}

async function readStandardListing(work: ListingWork, signal: AbortSignal): Promise<BrandListing> {
  const { pages, credits: pageCredits, nameResolution } = await readPages(work, signal);
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
    ...(nameResolution ? { nameResolution } : {}),
  };
}
