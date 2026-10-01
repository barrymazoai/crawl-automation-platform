import type { BrowserPage, BrowserRead, ListScroll, ObjectStore } from "@crawl-automation/platform";
import type { HttpPolicy } from "../adapter.js";
import type { ListingPage } from "./brand-scan.js";
import { ListingArchive, type ArchivedListing } from "./browser-listing-archive.js";
import {
  BrowserListingReader,
  type BrowserListingReaderOptions,
} from "./browser-listing-reader.js";

/** Each read closes and verifies absence of its task-owned page before returning. */
export interface ScanBrowser {
  readonly provider: string;
  read(request: BrowserRead, signal: AbortSignal): Promise<BrowserPage>;
}

export interface BrowserScanRequest {
  scanId: string;
  sourceUrl: string;
  /** Checked only between completed page reads and archives. Local worker callback, never serialized. */
  checkpoint?: (() => Promise<void>) | undefined;
}

export interface BrowserBrandScan {
  sourceUrl: string;
  pages: ListingPage[];
  complete: boolean;
  soldHere: boolean;
  archiveKeys: string[];
  cooldownRequested?: boolean;
}

export interface BrowserListingScanOptions extends BrowserListingReaderOptions {
  browser: ScanBrowser;
  remote: ObjectStore;
  storeId: string;
  policy: HttpPolicy;
  scroll: ListScroll;
  canaryUrl: string;
  readySelector: string;
  isUnverified(error: unknown): boolean;
  throttled(archiveKeys: string[], cause?: unknown): Error;
}

/** Archive before parsing, keep broken-list sightings, and confirm empty brands with a canary. */
export class BrowserListingScan extends BrowserListingReader {
  constructor(private readonly options: BrowserListingScanOptions) {
    super(options);
  }

  async scan(request: BrowserScanRequest, signal: AbortSignal): Promise<BrowserBrandScan> {
    await request.checkpoint?.();
    const url = this.sourceUrl(request.sourceUrl);
    const saved = await this.read({ scanId: request.scanId, label: "search", url }, signal);
    const listing = this.options.parse(saved.html, saved.record.scroll.observedItems);
    const archiveKeys = [saved.key];
    if (!listing.soldHere) {
      await request.checkpoint?.();
      archiveKeys.push(await this.checkCanary(request.scanId, signal));
      if (!clean(saved)) {
        throw this.options.throttled(archiveKeys);
      }
    }
    return {
      sourceUrl: url,
      pages: [{ ...listing.page, soldHere: listing.soldHere }],
      complete: clean(saved) && saved.record.scroll.ended === "stable",
      soldHere: listing.soldHere,
      archiveKeys,
      ...(saved.record.scroll.ended === "broken" ? { cooldownRequested: true } : {}),
    };
  }

  private async checkCanary(scanId: string, signal: AbortSignal): Promise<string> {
    const saved = await this.read({ scanId, label: "canary", url: this.options.canaryUrl }, signal);
    const keys = [`v3/brand-scans/${scanId}/search.html`, saved.key];
    if (!clean(saved)) {
      throw this.options.throttled(keys);
    }
    try {
      if (this.options.parse(saved.html).soldHere) {
        return saved.key;
      }
    } catch (error) {
      if (!this.options.isUnverified(error)) {
        throw error;
      }
      throw this.options.throttled(keys, error);
    }
    throw this.options.throttled(keys);
  }

  private async read(place: { scanId: string; label: string; url: string }, signal: AbortSignal) {
    const archive = new ListingArchive(this.options.remote, { ...place, maxBytes: this.maxBytes });
    const saved = await archive.inspect(signal);
    if (saved) {
      return saved;
    }
    const { browser, scroll, policy, storeId, readySelector } = this.options;
    const page = await browser.read(
      {
        url: place.url,
        readySelector,
        timeoutMs: policy.timeoutMs,
        scroll: {
          ...scroll,
          // The canary verifies initial results, never another brand's entire catalog.
          ...(place.label === "canary" ? { moreTexts: [], maxRounds: scroll.stableRounds } : {}),
        },
      },
      signal,
    );
    return archive.save({ page, url: place.url, provider: browser.provider, storeId }, signal);
  }
}

function clean(saved: ArchivedListing): boolean {
  return (
    saved.record.ready !== false &&
    (saved.record.status == null || saved.record.status < 400) &&
    !saved.record.readinessFailure &&
    saved.record.scroll.ended !== "broken"
  );
}
