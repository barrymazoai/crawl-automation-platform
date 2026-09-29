import type {
  ListingPage,
  ListingPageRead,
  ListingPageRequest,
} from "@crawl-automation/channels-core";
import type { QueuedProduct } from "../queue/queue-model.js";
import type {
  ScanChannel,
  ScanListQuery,
  ScanRecord,
  ScanResult,
  ScanSource,
} from "./scan-model.js";

/** `brand_scan`: scans requested, claimed and finished; and the brand sources they read. */
export interface BrandScanStore {
  sources(sourceIds: readonly string[]): Promise<ScanSource[]>;
  enabledSources(channel: ScanChannel): Promise<ScanSource[]>;
  /** One scan per (request, source); asking again returns the scans already requested. */
  request(requestId: string, sources: readonly ScanSource[]): Promise<ScanRecord[]>;
  /**
   * Up to `limit` scans to run now: queued ones, and running ones whose process stopped more than `staleMs` ago
   * (their pages are archived, so running them again reads the archive and pays nothing twice).
   */
  claim(limit: number, staleMs: number): Promise<ScanRecord[]>;
  finish(scanId: string, result: ScanResult): Promise<void>;
  list(query: ScanListQuery): Promise<ScanRecord[]>;
  /** The listings of this source ever queued by earlier lists (not by the scan itself). */
  knownListings(source: ScanSource, exceptBatchId: string): Promise<QueuedProduct[]>;
}

/** Listing pages through ScraperAPI, archived before they are read (channels-core `ListingPages`). */
export interface ListingPageReader {
  read(request: ListingPageRequest, signal: AbortSignal): Promise<ListingPageRead>;
}

/** What a browser brand scan found (Whole Foods: its search page drawn and scrolled for the configured store). */
export interface BrowserBrandScan {
  pages: ListingPage[];
  /** The list was scrolled to its end; a list stopped early is partial and never suggests a listing is gone. */
  complete: boolean;
  /** False when the search has no results: the brand is not sold here. */
  soldHere: boolean;
  archiveKeys: string[];
}

/**
 * A channel scanned in a browser, one of the two owner-approved browser cases
 * (docs/spark/2026-09-28-channel-brand-adapters-plan.md): its pages are drawn by script and cannot come through
 * ScraperAPI. The scanner archives what it read before returning.
 */
export interface BrowserBrandScanner {
  sourceUrl(url: string): string;
  scan(
    request: { scanId: string; sourceUrl: string },
    signal: AbortSignal,
  ): Promise<BrowserBrandScan>;
}

export type BrowserBrandScanners = Partial<Record<ScanChannel, BrowserBrandScanner>>;
