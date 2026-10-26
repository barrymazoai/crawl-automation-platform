import { z } from "zod";
import type { NotSupplementDelivered, ProductSyncLedger, SyncKey } from "./ledger.js";

const channel = z.enum(["amazon", "gnc", "swanson", "wholefoods", "costco"]);

/** A dry run by default: it re-checks every candidate in Supply Smart and deletes nothing. */
export const RemoveNotSupplementsSchema = z.strictObject({
  channel: channel.optional(),
  limit: z.number().int().min(1).max(500),
  /** The previous answer's `next`: products kept in Supply Smart stay candidates, so a page starts after them. */
  after: z
    .strictObject({
      channel,
      listingId: z.string().min(1).max(200),
      variantId: z.string().min(1).max(200).nullable(),
    })
    .optional(),
  dryRun: z.boolean().default(true),
});
export type RemoveNotSupplements = z.input<typeof RemoveNotSupplementsSchema>;

/** What Supply Smart says about one product, read just before deciding to delete it. */
export interface SupplySmartProductFacts {
  source: string | null;
  listings: { id: string; channel: string }[];
  formulaId: string | null;
  formulaObservations: number;
}

export interface SupplySmartProducts {
  /** Fails for an unknown product: Supply Smart has no "not found" answer to tell a deleted one apart. */
  facts(productId: string, signal: AbortSignal): Promise<SupplySmartProductFacts>;
  delete(productId: string, signal: AbortSignal): Promise<void>;
}

export type KeepReason =
  | "PRODUCT_SYNC.KEEP_NOT_CRAWLER_CREATED"
  | "PRODUCT_SYNC.KEEP_OTHER_LISTINGS"
  | "PRODUCT_SYNC.KEEP_HAS_FORMULA";

/**
 * Only a product the crawler created, whose one listing is this one, and which never had a formula is deleted
 * (owner 2026-10-26, group A). A legacy import or a product with another listing keeps its other data.
 */
export function keepReason(
  candidate: NotSupplementDelivered,
  facts: SupplySmartProductFacts,
): KeepReason | null {
  if (facts.source !== "enrichment") {
    return "PRODUCT_SYNC.KEEP_NOT_CRAWLER_CREATED";
  }
  const [only, ...others] = facts.listings;
  if (
    !only ||
    others.length ||
    only.channel !== candidate.channel ||
    (candidate.supplySmartListingId !== null && only.id !== candidate.supplySmartListingId)
  ) {
    return "PRODUCT_SYNC.KEEP_OTHER_LISTINGS";
  }
  if (facts.formulaId !== null || facts.formulaObservations > 0) {
    return "PRODUCT_SYNC.KEEP_HAS_FORMULA";
  }
  return null;
}

interface Kept {
  channel: string;
  listingId: string;
  productId: string;
  reason: KeepReason;
}

export interface RemovalReport {
  dryRun: boolean;
  /** Products read from Supply Smart and decided. */
  checked: number;
  /** Deletable: deleted unless this is a dry run. */
  removable: number;
  removed: number;
  /**
   * Another ledger row (another variant of the listing) points at a product this run or an earlier one removed;
   * only the row is recorded, Supply Smart is not called again.
   */
  sameProduct: number;
  kept: Kept[];
  /** The first failure stops the run; everything before it is recorded. */
  failure: { productId: string; message: string; details?: unknown } | null;
  /** Pass as `after` for the next page; null when this page was the last (or the run stopped on a failure). */
  next: SyncKey | null;
}

/**
 * Deletes, through the Supply Smart API, products of listings outside supplements (PRODUCT.NOT_SUPPLEMENT). Since
 * 2026-10-26 the sync no longer sends them; this removes the ones sent before. Candidates go one at a time, in key
 * order: facts, decision, delete, then the ledger row becomes `removed`. Pattern: Command with a dry-run preview.
 */
export class NotSupplementRemoval {
  constructor(
    private readonly deps: { ledger: ProductSyncLedger; products: SupplySmartProducts },
  ) {}

  async run(
    raw: RemoveNotSupplements,
    signal = new AbortController().signal,
  ): Promise<RemovalReport> {
    const input = RemoveNotSupplementsSchema.parse(raw);
    const candidates = await this.deps.ledger.notSupplementsDelivered({
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.after ? { after: input.after } : {}),
      limit: input.limit,
    });
    const report = emptyReport(input.dryRun);
    const decided = new Set<string>();
    for (const candidate of candidates) {
      signal.throwIfAborted();
      try {
        await this.one(candidate, { dryRun: input.dryRun, decided, report }, signal);
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        report.failure = failureOf(candidate.supplySmartProductId, error);
        return report;
      }
    }
    const last = candidates.length === input.limit ? candidates.at(-1) : undefined;
    report.next = last
      ? { channel: last.channel, listingId: last.listingId, variantId: last.variantId }
      : null;
    return report;
  }

  /** One candidate: a product already decided only records its row; otherwise facts, decision, delete. */
  private async one(
    candidate: NotSupplementDelivered,
    run: { dryRun: boolean; decided: Set<string>; report: RemovalReport },
    signal: AbortSignal,
  ) {
    const { report } = run;
    const productId = candidate.supplySmartProductId;
    if (candidate.productRemoved || run.decided.has(productId)) {
      report.sameProduct += 1;
      return run.dryRun ? undefined : this.recordRemoved(candidate);
    }
    const facts = await this.deps.products.facts(productId, signal);
    report.checked += 1;
    const reason = keepReason(candidate, facts);
    if (reason) {
      const { channel, listingId } = candidate;
      report.kept.push({ channel, listingId, productId, reason });
      return undefined;
    }
    report.removable += 1;
    run.decided.add(productId);
    if (run.dryRun) {
      return undefined;
    }
    await this.deps.products.delete(productId, signal);
    await this.recordRemoved(candidate);
    report.removed += 1;
    return undefined;
  }

  private recordRemoved(candidate: NotSupplementDelivered) {
    const { channel, listingId, variantId } = candidate;
    return this.deps.ledger.markRemoved({ channel, listingId, variantId });
  }
}

function emptyReport(dryRun: boolean): RemovalReport {
  return {
    dryRun,
    checked: 0,
    removable: 0,
    removed: 0,
    sameProduct: 0,
    kept: [],
    failure: null,
    next: null,
  };
}

function failureOf(productId: string, error: unknown): NonNullable<RemovalReport["failure"]> {
  const details = (error as { details?: unknown } | null)?.details;
  return {
    productId,
    message: error instanceof Error ? error.message : String(error),
    ...(details === undefined ? {} : { details }),
  };
}
