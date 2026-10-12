import type { DeliveryItem, DeliveryLabel } from "../product-delivery/wire.js";
import type { SyncChange, SyncKey } from "./ledger.js";
import type {
  MarketplaceChannel,
  MarketplaceCursor,
  MarketplaceProduct,
} from "./marketplace-model.js";

export interface ProductSyncRequest {
  channel: MarketplaceChannel;
  /** Products read from the crawler (one page); at most one ingest batch is sent per call. */
  limit: number;
  after?: MarketplaceCursor;
  /** Count only: no Supply Smart call and no ledger write. */
  dryRun: boolean;
  pending?: boolean;
}

export interface ProductSyncResult {
  channel: MarketplaceChannel;
  dryRun: boolean;
  read: number;
  unchanged: number;
  waitingCompany: number;
  material: number;
  toSend: number;
  verified: number;
  needsReview: number;
  failed: { externalId: string; reason: string }[];
  ingestRunId: string | null;
  /** The partial ingest run was closed in Supply Smart (null when nothing was sent). */
  runCompleted: boolean | null;
  after: MarketplaceCursor | null;
}

/** One product ready to send: its ledger key, wire payloads and their hash. */
export interface PlannedSync {
  product: MarketplaceProduct;
  key: SyncKey;
  item: DeliveryItem;
  label: DeliveryLabel | null;
  hash: string;
}

/** What one call collects: the counts it reports, the ledger rows it writes, and unchanged rows to touch. */
export interface SyncTally {
  result: ProductSyncResult;
  changes: SyncChange[];
  touched: (SyncKey & { materialAt: string })[];
}

export const syncKeyOf = (product: MarketplaceProduct): SyncKey => ({
  channel: product.channel,
  listingId: product.listingId,
  variantId: product.variantId,
});

export const syncKeyString = (key: SyncKey) =>
  `${key.channel}\u0000${key.listingId}\u0000${key.variantId ?? ""}`;

export const reasonText = (reason: string) => reason.slice(0, 500);

/** The read time stands in only for a product read without a watermark (never the sweep's pending reads). */
export const materialOf = (product: MarketplaceProduct) =>
  product.materialAt ?? new Date().toISOString();

/** Recorded so the automatic sweep does not pick it up again until the product settles again. */
export function materialProblem(tally: SyncTally, product: MarketplaceProduct, reason: string) {
  const key = syncKeyOf(product);
  tally.result.material += 1;
  tally.result.failed.push({ externalId: key.variantId ?? key.listingId, reason });
  tally.changes.push({
    ...key,
    status: "failed",
    error: { reason: reasonText(reason) },
    materialAt: materialOf(product),
  });
}

/** The ledger fields every send attempt writes. */
export function sentChange(entry: PlannedSync, runId: string): SyncChange {
  return {
    ...entry.key,
    status: "sent",
    collectedOperationId: entry.product.collection?.operationId ?? null,
    payloadHash: entry.hash,
    ingestRunId: runId,
    materialAt: materialOf(entry.product),
  };
}
