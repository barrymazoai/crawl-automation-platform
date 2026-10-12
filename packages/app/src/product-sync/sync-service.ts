import type { ProductObservationWriter } from "../product-delivery/ports.js";
import type { ProductSyncLedger, SyncChange } from "./ledger.js";
import type { MarketplacePage, MarketplaceReadRequest } from "./marketplace-model.js";
import type { BrandCompanyRepository } from "./ports.js";
import {
  sentChange,
  syncKeyOf,
  type PlannedSync,
  type ProductSyncRequest,
  type ProductSyncResult,
  type SyncTally,
} from "./sync-model.js";
import { planSync } from "./sync-plan.js";
import { sendBatch } from "./sync-send.js";

export type { ProductSyncRequest, ProductSyncResult } from "./sync-model.js";

/** Supply Smart accepts at most 200 items per ingest batch (07-crawler-ingest-contract). */
export const SYNC_BATCH_LIMIT = 200;

export interface ProductSyncDeps {
  reader: { read(request: MarketplaceReadRequest, signal: AbortSignal): Promise<MarketplacePage> };
  brands: Pick<BrandCompanyRepository, "matches">;
  ledger: ProductSyncLedger;
  writer: ProductObservationWriter;
  now?: () => Date;
}

/**
 * Marketplace products to Supply Smart (plan 2026-10-12): only products whose brand has a matched company; a listing
 * already in Supply Smart (ledger `present`, or `verified` with the same payload) is not sent again. Partial runs
 * only: a marketplace page set never proves a complete catalogue, so nothing is delisted.
 */
export class ProductSyncService {
  constructor(private readonly deps: ProductSyncDeps) {}

  async sync(request: ProductSyncRequest, signal: AbortSignal): Promise<ProductSyncResult> {
    const page = await this.read(request, signal);
    const tally = {
      result: emptyResult(request, page),
      changes: [] as SyncChange[],
      touched: [] as SyncTally["touched"],
    };
    const runId = `marketplace-sync-${request.channel}-${(this.deps.now?.() ?? new Date()).toISOString()}`;
    const brandIds = page.products.flatMap((product) => (product.brandId ? [product.brandId] : []));
    const planned = planSync(
      {
        products: page.products,
        runId,
        ledger: await this.deps.ledger.read(page.products.map(syncKeyOf)),
        matches: await this.deps.brands.matches([...new Set(brandIds)]),
      },
      tally,
    );
    tally.result.toSend = planned.length;
    if (!request.dryRun) {
      await this.deps.ledger.touch(tally.touched);
      await this.send({ runId, planned, tally }, signal);
    }
    return tally.result;
  }

  /**
   * An attempt is on record before Supply Smart is called: if anything below throws, these stay `sent` (unknown)
   * and are not resent until the product settles again (review 2026-10-12). Outcomes are written either way.
   */
  private async send(
    at: { runId: string; planned: PlannedSync[]; tally: SyncTally },
    signal: AbortSignal,
  ) {
    const { runId, planned, tally } = at;
    const [first, ...rest] = planned;
    if (!first) {
      await this.deps.ledger.record(tally.changes);
      return;
    }
    tally.result.ingestRunId = runId;
    await this.deps.ledger.record(planned.map((entry) => sentChange(entry, runId)));
    try {
      await sendBatch(
        { writer: this.deps.writer, runId, planned: [first, ...rest] },
        tally,
        signal,
      );
    } finally {
      await this.deps.ledger.record(tally.changes);
    }
  }

  private read(request: ProductSyncRequest, signal: AbortSignal) {
    const limit = Math.min(Math.max(1, Math.trunc(request.limit)), SYNC_BATCH_LIMIT);
    return this.deps.reader.read(
      {
        channel: request.channel,
        limit,
        ...(request.after ? { after: request.after } : {}),
        // Only the pending selection may send: it is what keeps `sent`, `present` and verified rows from being
        // sent again. A non-pending read is a count (dry run) only (review 2026-10-12).
        ...(request.pending || !request.dryRun ? { pending: true } : {}),
      },
      signal,
    );
  }
}

function emptyResult(request: ProductSyncRequest, page: MarketplacePage): ProductSyncResult {
  return {
    channel: request.channel,
    dryRun: request.dryRun,
    read: page.products.length,
    unchanged: 0,
    waitingCompany: 0,
    material: 0,
    toSend: 0,
    verified: 0,
    needsReview: 0,
    failed: [],
    ingestRunId: null,
    runCompleted: null,
    after: page.after ?? null,
  };
}
