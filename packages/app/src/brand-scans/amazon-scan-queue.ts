import { z } from "zod";
import { appErrors } from "../errors.js";
import { AddToQueueSchema, QueuedProductSchema, type QueuedProduct } from "../queue/queue-model.js";
import type { QueueService } from "../queue/queue-service.js";
import type { ScanRecord } from "./scan-model.js";

type ScanProduct = Pick<QueuedProduct, "url" | "listingId" | "variantId">;

/** Preserve the scan's canonical ASIN and URL validation before enqueueing. */
const scanProduct = QueuedProductSchema.omit({ sourceId: true })
  .extend({
    listingId: z.string().regex(/^[A-Z0-9]{10}$/),
    variantId: z.null(),
  })
  .refine((entry) => entry.url === `https://www.amazon.com/dp/${entry.listingId}`);
const scanProducts = z
  .array(scanProduct)
  .min(1)
  .max(10_000)
  .refine(
    (products) => new Set(products.map((product) => product.listingId)).size === products.length,
  );

export interface AmazonScanQueue {
  knownListings(scan: ScanRecord): Promise<QueuedProduct[]>;
  add(
    scan: ScanRecord,
    products: readonly ScanProduct[],
    batchId: string,
  ): Promise<{ added: number }>;
}

export interface AmazonScanQueueDeps {
  queue: Pick<QueueService, "add">;
  /** Read retained listings, excluding this scan's own batch. */
  knownListings(scan: ScanRecord): Promise<QueuedProduct[]>;
}

/** Bridges scan products to the shared queue using the scan's source and stable batch IDs. */
export class AmazonBrandScanQueue implements AmazonScanQueue {
  constructor(private readonly deps: AmazonScanQueueDeps) {}

  knownListings(scan: ScanRecord): Promise<QueuedProduct[]> {
    return this.deps.knownListings(scan);
  }

  async add(scan: ScanRecord, products: readonly ScanProduct[], batchId: string) {
    if (!products.length) {
      return { added: 0 };
    }
    if (scan.source.channel !== "amazon") {
      throw appErrors.create("QUEUE.SOURCE_CHANNEL_MISMATCH");
    }
    // Revisit inputs can carry a historical sourceId; the scan owns this new batch's source.
    const candidates = products.map(({ url, listingId, variantId }) => ({
      url,
      listingId,
      variantId,
    }));
    return this.deps.queue.add(
      AddToQueueSchema.parse({
        channel: "amazon",
        batchId,
        label: `brand scan: ${scan.source.brandName}`.slice(0, 200),
        products: scanProducts.parse(candidates).map((product) => ({
          ...product,
          sourceId: scan.source.sourceId,
        })),
      }),
    );
  }
}
