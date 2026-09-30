import { setTimeout as delay } from "node:timers/promises";
import { errorCodeOf, type Logger } from "@crawl-automation/platform";
import { z } from "zod";
import type { ListingStateService } from "../listings/listing-state-service.js";
import type { QueueService } from "../queue/queue-service.js";
import type { QueuedProduct } from "../queue/queue-model.js";
import type { BrandScanStore } from "./ports.js";
import { readListing, type BrandListing } from "./scan-listing.js";
import type { ScanReaders } from "./scan-listing.js";
import type { ScanChannel, ScanRecord, ScanResult } from "./scan-model.js";
import type { AmazonScanQueue } from "./amazon-scan-queue.js";
import { appErrors } from "../errors.js";

export const BrandScanRunnerSettingsSchema = z.strictObject({
  intervalMs: z.number().int().min(500).max(60_000).default(5_000),
  /** Brands scanned at once; each scan reads its pages one after another. */
  concurrent: z.number().int().min(1).max(32).default(4),
  /** A running scan untouched this long is taken over (its pages are archived; nothing is paid twice). */
  staleMs: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
});
export type BrandScanRunnerSettings = z.infer<typeof BrandScanRunnerSettingsSchema>;

export interface BrandScanRunnerDeps extends ScanReaders {
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
    const amazon = scan.source.channel === "amazon" ? this.amazonQueue() : null;
    const listing = await readListing(this.deps, scan, signal);
    // Known: queued by an earlier list of this source (the scan's own list is excluded).
    const known = amazon
      ? await amazon.knownListings(scan)
      : await this.deps.store.knownListings(scan.source, scan.scanId);
    const queued = await this.queueAll(scan, listing);
    const counts = compare(listing, known);
    const missing = listing.full ? await this.revisitMissing(scan, counts.missing) : 0;
    return {
      state: listing.full ? "complete" : "partial",
      pages: listing.pages.length,
      products: listing.products.length,
      families: listing.families,
      unresolvedFamilies: listing.unresolvedFamilies,
      statedTotal: listing.pages.at(-1)?.statedTotal ?? null,
      full: listing.full,
      capped: listing.capped ?? false,
      newListings: counts.newListings,
      knownListings: counts.knownListings,
      missing,
      queued,
      credits: listing.credits,
      code: null,
    };
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

const keyOf = (item: { listingId: string; variantId: string | null }) =>
  `${item.listingId}\u0000${item.variantId ?? ""}`;

/** Listed products split into new and already known; known listings the listing no longer shows. */
function compare(listing: BrandListing, known: QueuedProduct[]) {
  const knownKeys = new Set(known.map(keyOf));
  const listedKeys = new Set(listing.products.map(keyOf));
  const knownListings = [...listedKeys].filter((key) => knownKeys.has(key)).length;
  return {
    newListings: listedKeys.size - knownListings,
    knownListings,
    missing: known.filter((item) => !listedKeys.has(keyOf(item))),
  };
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
    capped: false,
    newListings: null,
    knownListings: null,
    missing: 0,
    queued: 0,
    credits: 0,
    code: null,
  };
}
