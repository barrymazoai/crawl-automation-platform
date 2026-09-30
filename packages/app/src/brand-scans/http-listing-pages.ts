import {
  brandScanErrors,
  type BrandScanReader,
  type ChannelAdapter,
  type ChannelId,
  type ListingPage,
} from "@crawl-automation/channels-core";
import type { ListingPageReader } from "./ports.js";
import type { ScanRecord } from "./scan-model.js";

export type ListingScan = Pick<ScanRecord, "scanId"> & {
  source: Pick<ScanRecord["source"], "sourceId" | "channel" | "url">;
};

export interface ListingWork {
  scan: ListingScan;
  adapter: ChannelAdapter;
  reader: BrandScanReader;
  pages: ListingPageReader;
}

export function listingTarget(work: ListingWork) {
  return {
    scanId: work.scan.scanId,
    channel: work.adapter.id as ChannelId,
    origins: work.reader.origins ?? work.adapter.httpPolicy.origins,
  };
}

/** Resolution uses the same verified archive as listing pages, under its own stable label. */
async function resolveSource(work: ListingWork, signal: AbortSignal) {
  const source = work.reader.sourceUrl(work.scan.source.url);
  const resolve = work.reader.resolve;
  if (!resolve) {
    return { source, credits: 0 };
  }
  const url = resolve.pageUrl(source);
  const read = await work.pages.read(
    {
      ...listingTarget(work),
      url,
      label: "resolve",
      answer: resolve.answer,
      maxBytes: resolve.maxBytes,
    },
    signal,
  );
  return { source: resolve.parsePage({ body: read.body, url }), credits: read.creditCost ?? 0 };
}

/** Read consecutive archived pages; readers can report a bounded partial scan at their own cap. */
export async function readPages(work: ListingWork, signal: AbortSignal) {
  const { reader } = work;
  const resolved = await resolveSource(work, signal);
  const pages: ListingPage[] = [];
  let credits = resolved.credits;
  for (let page = 1; ; page++) {
    if (page > reader.maxPages) {
      throw brandScanErrors.create("BRAND_SCAN.PAGE_LIMIT", {
        details: { maxPages: reader.maxPages },
      });
    }
    const url = reader.pageUrl(resolved.source, page);
    const read = await work.pages.read(
      {
        ...listingTarget(work),
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
    if (listed.nextPage !== page + 1) {
      throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
    }
  }
}
