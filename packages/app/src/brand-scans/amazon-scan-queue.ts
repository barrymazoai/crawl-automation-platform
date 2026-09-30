import { createHash } from "node:crypto";
import {
  CatalogEntrySchema,
  CatalogScopeSchema,
  Sha256Schema,
  type CatalogScope,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { appErrors } from "../errors.js";
import { identifyListing, type ListingIdentityResolver } from "../history/listing-identity.js";
import type { QueuedProduct } from "../queue/queue-model.js";
import type { QueueService } from "../queue/queue-service.js";
import type { ScanRecord } from "./scan-model.js";

type ScanProduct = Pick<QueuedProduct, "url" | "listingId" | "variantId">;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Validate scan output against the existing queue wire format without loading legacy channels. */
const scanEntry = CatalogEntrySchema.extend({
  listingId: z.string().regex(/^[A-Z0-9]{10}$/),
  variantId: z.null(),
  kind: z.literal("product"),
}).refine((entry) => entry.url === `https://www.amazon.com/dp/${entry.listingId}`);
const scanBatch = z.strictObject({
  codec: z.literal("amazon-link-batch/1"),
  requestId: z.uuid(),
  scope: CatalogScopeSchema.refine((scope) => scope.channel === "amazon"),
  candidateManifestSha256: Sha256Schema,
  entries: z
    .array(
      z.strictObject({
        entry: scanEntry,
        candidateId: Sha256Schema,
        historyListingId: Sha256Schema,
      }),
    )
    .min(1)
    .max(10)
    .refine(
      (entries) => new Set(entries.map(({ entry }) => entry.listingId)).size === entries.length,
    ),
});
const scanBatches = z
  .array(scanBatch)
  .max(2_000)
  .refine((batches) => new Set(batches.map((batch) => batch.requestId)).size === batches.length);

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
  identities: ListingIdentityResolver;
  /** Resolve the brand's enabled US root source with its exact deployed scope version. */
  scopeFor(scan: ScanRecord): Promise<CatalogScope>;
  /** Read Amazon's existing queue/history, excluding this scan's campaign. */
  knownListings(scan: ScanRecord): Promise<QueuedProduct[]>;
}

/** Stable request IDs are necessary for exact input equality when a claimed scan resumes. */
function batchRequestId(batchId: string, index: number): string {
  const hex = digest(["brand-scan-batch", batchId, index]);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function batchEntry(product: ScanProduct, batchId: string, identities: ListingIdentityResolver) {
  const identity = identifyListing(
    {
      channel: "amazon",
      url: product.url,
      listingId: product.listingId,
      externalId: product.listingId,
      sourceKey: batchId,
      dataset: "brand-scan",
    },
    identities,
  );
  return {
    entry: { ...product, kind: "product" as const },
    candidateId: digest([batchId, product.listingId]),
    historyListingId: identity.id,
  };
}

/** Bridges scan products to Amazon's existing queue; never routes them into the shared queue. */
export class AmazonBrandScanQueue implements AmazonScanQueue {
  constructor(private readonly deps: AmazonScanQueueDeps) {}

  knownListings(scan: ScanRecord): Promise<QueuedProduct[]> {
    return this.deps.knownListings(scan);
  }

  async add(scan: ScanRecord, products: readonly ScanProduct[], batchId: string) {
    if (!products.length) {
      return { added: 0 };
    }
    const scope = await this.deps.scopeFor(scan);
    if (scope.channel !== "amazon" || scope.brandId !== scan.source.brandId) {
      throw appErrors.create("QUEUE.SOURCE_CHANNEL_MISMATCH");
    }
    const entries = products.map((product) =>
      batchEntry(
        {
          url: product.url,
          listingId: product.listingId,
          variantId: product.variantId,
        },
        batchId,
        this.deps.identities,
      ),
    );
    const candidateManifestSha256 = digest({ batchId, scope, entries });
    const batches = [];
    for (let index = 0; index < entries.length; index += 10) {
      batches.push({
        codec: "amazon-link-batch/1",
        scope,
        candidateManifestSha256,
        requestId: batchRequestId(batchId, index),
        entries: entries.slice(index, index + 10),
      });
    }
    return this.deps.queue.add({
      channel: "amazon",
      campaignId: batchId,
      batches: scanBatches.parse(batches),
    });
  }
}
