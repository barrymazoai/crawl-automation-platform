import { setTimeout } from "node:timers/promises";
import {
  brandScanErrors,
  type BrandScanReader,
  type ChannelAdapter,
  type ChannelId,
  type ListingPage,
  type ListingPolicyRequest,
  type ListingResolveStep,
} from "@crawl-automation/channels-core";
import type { ListingPageReader } from "./ports.js";
import type { ScanRecord } from "./scan-model.js";

export type ListingScan = Pick<ScanRecord, "scanId"> & {
  source: Pick<ScanRecord["source"], "sourceId" | "channel" | "url"> & {
    /** Optional for workflows started before names were included in listing requests. */
    brandName?: string | undefined;
  };
};

export interface ListingWork {
  scan: ListingScan;
  adapter: ChannelAdapter;
  reader: BrandScanReader;
  pages: ListingPageReader;
  requestIntervalMs?: number;
  checkpoint?: (() => Promise<void>) | undefined;
}

export function listingTarget(work: ListingWork) {
  return {
    scanId: work.scan.scanId,
    channel: work.adapter.id as ChannelId,
    origins: work.reader.origins ?? work.adapter.httpPolicy.origins,
  };
}

/** One pacing and credit counter for all resolution and listing reads, including archive reuse. */
export function pageReads(work: ListingWork, signal: AbortSignal) {
  let started = false;
  let credits = 0;
  return {
    get credits() {
      return credits;
    },
    read: async (request: ListingPolicyRequest) => {
      await work.checkpoint?.();
      const interval = work.requestIntervalMs ?? 0;
      if (started && interval > 0) {
        await setTimeout(interval, undefined, { signal });
      }
      signal.throwIfAborted();
      await work.checkpoint?.();
      started = true;
      const read = await work.pages.read({ ...listingTarget(work), ...request }, signal);
      credits += read.creditCost ?? 0;
      return read;
    },
  };
}

/** Each resolution step shares the archive and pacing; repeated labels fail before another read. */
async function resolveSource(work: ListingWork, read: ReturnType<typeof pageReads>["read"]) {
  const url = work.reader.sourceUrl(work.scan.source.url);
  let step: ListingResolveStep = work.reader.resolve?.({
    url,
    brandName: work.scan.source.brandName,
  }) ?? { sourceUrl: url };
  const labels = new Set<string>();
  while ("request" in step) {
    const { request } = step;
    if (labels.has(request.label)) {
      throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
    }
    labels.add(request.label);
    const result = await read(request);
    step = step.parsePage({ body: result.body, url: request.url });
  }
  return step;
}

async function readPage(
  work: ListingWork,
  target: { sourceUrl: string; page: number },
  read: ReturnType<typeof pageReads>["read"],
) {
  const { reader } = work;
  const url = reader.pageUrl(target.sourceUrl, target.page);
  const result = await read({
    url,
    label: `page-${target.page}`,
    answer: reader.answer,
    maxBytes: reader.maxBytes,
  });
  return reader.parsePage({ body: result.body, url, page: target.page });
}

/** Read consecutive archived pages; readers can report a bounded partial scan at their own cap. */
export async function readPages(work: ListingWork, signal: AbortSignal) {
  const { reader } = work;
  signal.throwIfAborted();
  const reads = pageReads(work, signal);
  const resolved = await resolveSource(work, reads.read);
  const pages: ListingPage[] = [];
  for (let page = 1; ; page++) {
    signal.throwIfAborted();
    if (page > reader.maxPages) {
      throw brandScanErrors.create("BRAND_SCAN.PAGE_LIMIT", {
        details: { maxPages: reader.maxPages },
      });
    }
    const listed =
      page === 1 && resolved.firstPage
        ? resolved.firstPage
        : await readPage(work, { sourceUrl: resolved.sourceUrl, page }, reads.read);
    pages.push(listed);
    if (listed.nextPage === null || listed.products.length === 0) {
      return {
        pages,
        credits: reads.credits,
        ...(resolved.nameResolution ? { nameResolution: resolved.nameResolution } : {}),
      };
    }
    if (listed.nextPage !== page + 1) {
      throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
    }
  }
}
