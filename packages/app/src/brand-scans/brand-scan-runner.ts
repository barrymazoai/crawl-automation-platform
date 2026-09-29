import { setTimeout as delay } from "node:timers/promises";
import { errorCodeOf, type Logger } from "@crawl-automation/platform";
import { z } from "zod";
import type { ListingStateService } from "../listings/listing-state-service.js";
import type { QueueService } from "../queue/queue-service.js";
import type { QueuedProduct } from "../queue/queue-model.js";
import type { BrandScanStore } from "./ports.js";
import type { BrandListing } from "./scan-listing.js";
import { readListing, type ScanReaders } from "./scan-readers.js";
import type { ScanChannel, ScanRecord, ScanResult } from "./scan-model.js";

export const BrandScanRunnerSettingsSchema = z.strictObject({
  intervalMs: z.number().int().min(500).max(60_000).default(5_000),
  /** Brands scanned at once; each scan reads its pages one after another. */
  concurrent: z.number().int().min(1).max(32).default(4),
  /** A running scan untouched this long is taken over (its pages are archived; nothing is paid twice). */
  staleMs: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
});
export type BrandScanRunnerSettings = z.infer<typeof BrandScanRunnerSettingsSchema>;

export interface BrandScanRunnerDeps extends ScanReaders {
  store: BrandScanStore;
  queue: Pick<QueueService, "add">;
  listings: Pick<ListingStateService, "requestRevisits">;
  log: Logger;
}

const toQueued =
  (scan: ScanRecord) =>
  (product: BrandListing["products"][number]): QueuedProduct => ({
    sourceId: scan.source.sourceId,
    url: product.url,
    listingId: product.listingId,
    variantId: product.variantId,
  });

/**
 * Runs requested brand scans: reads each brand's listing through ScraperAPI, puts ALL its products into the shared
 * queue (formula-once decides what is new), and after a full scan queues a direct revisit of every known listing
 * the brand no longer lists. Absence alone is never recorded as a sighting.
 */
export class BrandScanRunner {
  private readonly settings: BrandScanRunnerSettings;

  constructor(
    private readonly deps: BrandScanRunnerDeps,
    settings: Partial<BrandScanRunnerSettings> = {},
  ) {
    this.settings = BrandScanRunnerSettingsSchema.parse(settings);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch (error) {
        // One failed round never stops scanning; the next round starts from the table again.
        this.deps.log.error({ err: error, code: errorCodeOf(error) }, "brand scan round failed");
      }
      await delay(this.settings.intervalMs, undefined, { signal }).catch(() => undefined);
    }
  }

  async tick(signal: AbortSignal): Promise<void> {
    const scans = await this.deps.store.claim(this.settings.concurrent, this.settings.staleMs);
    await Promise.all(scans.map((scan) => this.scanOne(scan, signal)));
  }

  /** One scan to its end: a result, or a Review-state record with the failure's own code. */
  private async scanOne(scan: ScanRecord, signal: AbortSignal): Promise<void> {
    let result: ScanResult;
    try {
      result = await this.scan(scan, signal);
    } catch (error) {
      result = {
        ...emptyResult(),
        state: "review",
        code: errorCodeOf(error) ?? "BRAND_SCAN.UNRESOLVED",
      };
      this.deps.log.warn(
        { scanId: scan.scanId, err: error, code: result.code },
        "brand scan review",
      );
    }
    await this.deps.store.finish(scan.scanId, result);
    this.deps.log.info({ scanId: scan.scanId, ...result }, "brand scan finished");
  }

  private async scan(scan: ScanRecord, signal: AbortSignal): Promise<ScanResult> {
    const listing = await readListing(this.deps, scan, signal);
    const queued = await this.queueAll(scan, listing);
    const missing = listing.full ? await this.revisitMissing(scan, listing) : 0;
    return {
      state: listing.full ? "complete" : "partial",
      pages: listing.pages.length,
      products: listing.products.length,
      families: listing.families,
      unresolvedFamilies: listing.unresolvedFamilies,
      statedTotal: listing.pages.at(-1)?.statedTotal ?? null,
      full: listing.full,
      missing,
      queued,
      credits: listing.credits,
      code: null,
    };
  }

  /** Every listed product goes into the shared queue in one list; the scan's ID makes a rerun add nothing. */
  private async queueAll(scan: ScanRecord, listing: BrandListing): Promise<number> {
    if (listing.products.length === 0) {
      return 0;
    }
    const channel = scan.source.channel as ScanChannel;
    const products = listing.products.map(toQueued(scan));
    const label = `brand scan: ${scan.source.brandName}`.slice(0, 200);
    const { added } = await this.deps.queue.add({ channel, batchId: scan.scanId, label, products });
    return added;
  }

  /** Known listings a full scan no longer shows: each queued once for a direct revisit, which decides. */
  private async revisitMissing(scan: ScanRecord, listing: BrandListing): Promise<number> {
    const found = new Set(
      listing.products.map((product) => `${product.listingId}\u0000${product.variantId ?? ""}`),
    );
    const known = await this.deps.store.knownListings(scan.source, scan.scanId);
    const missing = known.filter(
      (item) => !found.has(`${item.listingId}\u0000${item.variantId ?? ""}`),
    );
    if (missing.length === 0) {
      return 0;
    }
    await this.deps.listings.requestRevisits({
      channel: scan.source.channel,
      scope: "full",
      batchId: scan.revisitBatchId,
      label: `revisit after brand scan: ${scan.source.brandName}`.slice(0, 200),
      listings: missing,
    });
    return missing.length;
  }
}

function emptyResult(): ScanResult {
  return {
    state: "review",
    pages: 0,
    products: 0,
    families: 0,
    unresolvedFamilies: 0,
    statedTotal: null,
    full: false,
    missing: 0,
    queued: 0,
    credits: 0,
    code: null,
  };
}
