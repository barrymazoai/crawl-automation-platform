import { compareScanListings } from "./scan-comparison.js";
import {
  cancelledScanResult,
  checkScanCancellation,
  emptyScanResult,
} from "./scan-cancellation.js";
import { listingScanResult } from "./listing-scan-result.js";
import { setTimeout as delay } from "node:timers/promises";
import { pipelineErrors, errorCodeOf, type Logger } from "@crawl-automation/platform";
import { z } from "zod";
import type { ListingStateService } from "../listings/listing-state-service.js";
import type { QueueService } from "../queue/queue-service.js";
import type { QueuedProduct } from "../queue/queue-model.js";
import type { BrandScanStore } from "./ports.js";
import { hasScanTotalProof } from "./scan-completeness.js";
import { readListing, type BrandListing } from "./scan-listing.js";
import type { ScanReaders } from "./scan-listing.js";
import type { ScanChannel, ScanRecord, ScanResult } from "./scan-model.js";
import type { AmazonScanQueue } from "./amazon-scan-queue.js";
import { appErrors } from "../errors.js";
import type { GatedBrandListing } from "./scan-permits.js";

export const BrandScanRunnerSettingsSchema = z.strictObject({
  intervalMs: z.number().int().min(500).max(60_000).default(5_000),
  /** Brands scanned at once; each scan reads its pages one after another. */
  concurrent: z.number().int().min(1).max(32).default(4),
  /** A running scan untouched this long is taken over (its pages are archived; nothing is paid twice). */
  staleMs: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
});
export type BrandScanRunnerSettings = z.infer<typeof BrandScanRunnerSettingsSchema>;

export interface BrandScanRunnerDeps extends ScanReaders {
  gatedListings?: Partial<Record<ScanChannel, GatedBrandListing>>;
  amazonQueue?: AmazonScanQueue;
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
 * Runs requested brand scans: reads each source with its declared capture, puts ALL its products into its
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
        ...emptyScanResult(),
        state: "review",
        code: errorCodeOf(error) ?? pipelineErrors.code("BRAND_SCAN.UNRESOLVED"),
      };
      this.deps.log.warn(
        { scanId: scan.scanId, err: error, code: result.code },
        "brand scan review",
      );
    }
    if (await this.deps.store.isCancellationRequested(scan.scanId)) {
      result = cancelledScanResult(result);
    }
    await this.deps.store.finish(scan.scanId, result);
    this.deps.log.info({ scanId: scan.scanId }, "brand scan finished");
  }

  private async scan(scan: ScanRecord, signal: AbortSignal): Promise<ScanResult> {
    const amazon = scan.source.channel === "amazon" ? this.amazonQueue() : null;
    const listing = await this.read(scan, signal);
    if (scan.source.channel === "wholefoods") {
      listing.full = hasScanTotalProof(listing);
    }
    const result: ScanResult = {
      ...listingScanResult(listing),
      newListings: null,
      knownListings: null,
      missing: 0,
      queued: 0,
    };
    // Known: queued by an earlier list of this source (the scan's own list is excluded).
    const known = amazon
      ? await amazon.knownListings(scan)
      : await this.deps.store.knownListings(scan.source, scan.scanId);
    if (await this.deps.store.isCancellationRequested(scan.scanId)) {
      return cancelledScanResult(result);
    }
    const queued = await this.queueAll(scan, listing);
    const counts = compareScanListings(listing, known);
    if (await this.deps.store.isCancellationRequested(scan.scanId)) {
      return cancelledScanResult({ ...result, ...counts, missing: 0, queued });
    }
    const missing = listing.full ? await this.revisitMissing(scan, counts.missing) : 0;
    return {
      ...listingScanResult(listing),
      newListings: counts.newListings,
      knownListings: counts.knownListings,
      missing,
      queued,
    };
  }

  private read(scan: ScanRecord, signal: AbortSignal): Promise<BrandListing> {
    const gated = this.deps.gatedListings?.[scan.source.channel as ScanChannel];
    return gated
      ? gated.read(scan, signal)
      : readListing(
          {
            ...this.deps,
            checkpoint: (scanId) => checkScanCancellation(this.deps.store, scanId),
          },
          scan,
          signal,
        );
  }

  /** Every listed product goes into its queue; the scan's ID makes a rerun add nothing. */
  private async queueAll(scan: ScanRecord, listing: BrandListing): Promise<number> {
    if (listing.products.length === 0) {
      return 0;
    }
    const channel = scan.source.channel as ScanChannel;
    if (channel === "amazon") {
      return (await this.amazonQueue().add(scan, listing.products, scan.scanId)).added;
    }
    const products = listing.products.map(toQueued(scan));
    const label = `brand scan: ${scan.source.brandName}`.slice(0, 200);
    const { added } = await this.deps.queue.add({ channel, batchId: scan.scanId, label, products });
    return added;
  }

  /** Known listings a full scan no longer shows: each queued once for a direct revisit, which decides. */
  private async revisitMissing(scan: ScanRecord, missing: QueuedProduct[]): Promise<number> {
    if (missing.length === 0) {
      return 0;
    }
    if (scan.source.channel === "amazon") {
      await this.amazonQueue().add(scan, missing, scan.revisitBatchId);
      return missing.length;
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

  private amazonQueue(): AmazonScanQueue {
    if (!this.deps.amazonQueue) {
      throw appErrors.create("BRAND_SCAN.NOT_CONFIGURED", {
        details: { component: "amazonQueue" },
      });
    }
    return this.deps.amazonQueue;
  }
}
