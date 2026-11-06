import type { ProductObservationWriter } from "../product-delivery/ports.js";
import type { MarketplaceChannel, ProductSyncLedger, SyncChange } from "./ledger.js";
import type { MarketplacePage, MarketplaceReadRequest } from "./marketplace-model.js";
import type { DomainResolution } from "@crawl-automation/v3-contracts";
import type { CrossMarketCheck } from "../cross-market/cross-market-check.js";
import type { BrandCompanyMatch } from "./brand-company-model.js";
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
import { withOutcomes, withTargetDomains } from "./sync-targets.js";
import { sendBatch } from "./sync-send.js";

export type { ProductSyncRequest, ProductSyncResult } from "./sync-model.js";

/** Supply Smart accepts at most 200 items per ingest batch (07-crawler-ingest-contract). */
export const SYNC_BATCH_LIMIT = 200;

export interface ProductSyncDeps {
  reader: { read(request: MarketplaceReadRequest, signal: AbortSignal): Promise<MarketplacePage> };
  brands: Pick<BrandCompanyRepository, "matches">;
  ledger: ProductSyncLedger;
  writer: ProductObservationWriter;
  /**
   * KAN-243: a channel sent to another Supply Smart than `writer`'s (amazon-in to the test database while amazon.com
   * goes to production). A channel without its own writer uses `writer`.
   */
  writers?: Partial<Record<MarketplaceChannel, SyncTarget>>;
  now?: () => Date;
}

/**
 * Another Supply Smart a channel is sent to. Company IDs differ between its database and production (Supply Smart,
 * 2026-11-05: production was copied from test on 2026-11-03, then both diverged), so a brand's company is resolved by
 * its domain in that database; a domain it does not know waits, so no product is created there without a company.
 */
export interface SyncTarget {
  writer: ProductObservationWriter;
  /** KAN-243: the cross-market check of this target's first listings; absent = no verdict is sent. */
  crossMarket?: Pick<CrossMarketCheck, "outcomes">;
  companies: {
    resolveDomain(domain: string, signal: AbortSignal): Promise<DomainResolution>;
  };
  /**
   * Brands with no production company match, by crawler brand ID, and the domain to resolve in this target instead
   * (amazon.in-only brands on the test database, owner 2026-11-06). A production match always comes first.
   */
  brandDomains?: Readonly<Record<string, string>>;
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
        matches: await this.matchesFor(request.channel, [...new Set(brandIds)], signal),
      },
      tally,
    );
    const ready = request.dryRun
      ? planned
      : await this.crossMarket({ channel: request.channel, planned, tally }, signal);
    tally.result.toSend = ready.length;
    if (!request.dryRun) {
      await this.deps.ledger.touch(tally.touched);
      await this.send(
        { runId, planned: ready, tally, writer: this.writerOf(request.channel) },
        signal,
      );
    }
    return tally.result;
  }

  /**
   * An attempt is on record before Supply Smart is called: if anything below throws, these stay `sent` (unknown)
   * and are not resent until the product settles again (review 2026-10-12). Outcomes are written either way.
   */
  private async send(
    at: {
      runId: string;
      planned: PlannedSync[];
      tally: SyncTally;
      writer: ProductObservationWriter;
    },
    signal: AbortSignal,
  ) {
    const { runId, planned, tally, writer } = at;
    const [first, ...rest] = planned;
    if (!first) {
      await this.deps.ledger.record(tally.changes);
      return;
    }
    tally.result.ingestRunId = runId;
    await this.deps.ledger.record(planned.map((entry) => sentChange(entry, runId)));
    try {
      await sendBatch({ writer, runId, planned: [first, ...rest] }, tally, signal);
    } finally {
      await this.deps.ledger.record(tally.changes);
    }
  }

  /** Each item carries its verdict; one waiting for the other storefront's page is left for a later round. */
  private async crossMarket(
    at: { channel: MarketplaceChannel; planned: PlannedSync[]; tally: SyncTally },
    signal: AbortSignal,
  ): Promise<PlannedSync[]> {
    const check = this.deps.writers?.[at.channel]?.crossMarket;
    if (!check || !at.planned.length) {
      return at.planned;
    }
    const outcomes = await check.outcomes(
      at.planned.map((entry) => entry.product),
      signal,
    );
    return withOutcomes(at.planned, outcomes, at.tally);
  }

  private writerOf(channel: MarketplaceChannel): ProductObservationWriter {
    return this.deps.writers?.[channel]?.writer ?? this.deps.writer;
  }

  /** The brands' company matches as the channel's own Supply Smart knows them. */
  private async matchesFor(channel: MarketplaceChannel, brandIds: string[], signal: AbortSignal) {
    const matches = await this.deps.brands.matches(brandIds);
    const target = this.deps.writers?.[channel];
    if (!target) {
      return matches;
    }
    const known = new Map(matches.map((match) => [match.brandId, match]));
    const resolved: BrandCompanyMatch[] = [];
    for (const match of withTargetDomains(brandIds, known, target.brandDomains)) {
      const answer =
        match.status === "matched" && match.domain
          ? await target.companies.resolveDomain(match.domain, signal)
          : null;
      resolved.push(
        answer?.status === "matched" && answer.companyId
          ? { ...match, companyId: answer.companyId }
          : { ...match, status: "unmatched", companyId: null },
      );
    }
    return resolved;
  }

  private targetBrands(channel: MarketplaceChannel): { matchedBrandIds?: string[] } {
    const brands = Object.keys(this.deps.writers?.[channel]?.brandDomains ?? {});
    return brands.length ? { matchedBrandIds: brands } : {};
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
        ...this.targetBrands(request.channel),
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
