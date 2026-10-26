import { z } from "zod";
import type { ProductSyncLedger, RefreshedHealthFunctions } from "./ledger.js";

/** A dry run by default: it reads every product's health functions in Supply Smart and removes nothing. */
export const CleanHealthFunctionsSchema = z.strictObject({
  limit: z.number().int().min(1).max(200),
  /** The previous answer's `next` (a Supply Smart product ID). */
  after: z.uuid().optional(),
  dryRun: z.boolean().default(true),
});
export type CleanHealthFunctions = z.input<typeof CleanHealthFunctionsSchema>;

export interface SupplySmartHealthFunctions {
  /** The product's linked health functions. */
  list(productId: string, signal: AbortSignal): Promise<{ id: string; name: string }[]>;
  /** Unlinks one health function from one product; the health function itself stays. */
  unlink(productId: string, healthFunctionId: string, signal: AbortSignal): Promise<void>;
}

export interface HealthFunctionCleanupReport {
  dryRun: boolean;
  /** Products read from Supply Smart. */
  checked: number;
  /** Links whose name only an earlier enrichment sent: unlinked unless this is a dry run. */
  removable: number;
  removed: number;
  /** Up to 20 examples of what is (or would be) unlinked. */
  examples: { productId: string; name: string }[];
  /** The first failure stops the run; everything before it is done. */
  failure: { productId: string; message: string } | null;
  /** Pass as `after` for the next page; null when this page was the last (or the run stopped on a failure). */
  next: string | null;
}

/** Supply Smart matches health function names case-insensitively; spacing differences are the same name too. */
const normalized = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The names a product's links should lose: names an earlier enrichment of our listings sent that no current one
 * sends. A name the crawler never sent (a legacy import, a person's edit) is never touched.
 */
export function staleLinks(
  product: RefreshedHealthFunctions,
  links: { id: string; name: string }[],
): { id: string; name: string }[] {
  const current = new Set(product.current.map(normalized));
  const stale = new Set(product.previous.map(normalized).filter((name) => !current.has(name)));
  return links.filter((link) => stale.has(normalized(link.name)));
}

/**
 * Product enrichment /4 names health functions as short categories; products sent with it still carry the printed
 * sentences sent before, because Supply Smart only adds health functions (owner 2026-10-26). This unlinks those
 * through the Supply Smart API, one product at a time in ID order. Pattern: Command with a dry-run preview.
 */
export class HealthFunctionCleanup {
  constructor(
    private readonly deps: {
      ledger: Pick<ProductSyncLedger, "refreshedHealthFunctions">;
      healthFunctions: SupplySmartHealthFunctions;
    },
  ) {}

  async run(
    raw: CleanHealthFunctions,
    signal = new AbortController().signal,
  ): Promise<HealthFunctionCleanupReport> {
    const input = CleanHealthFunctionsSchema.parse(raw);
    const products = await this.deps.ledger.refreshedHealthFunctions({
      ...(input.after ? { after: input.after } : {}),
      limit: input.limit,
    });
    const report: HealthFunctionCleanupReport = {
      dryRun: input.dryRun,
      checked: 0,
      removable: 0,
      removed: 0,
      examples: [],
      failure: null,
      next: null,
    };
    for (const product of products) {
      signal.throwIfAborted();
      try {
        await this.one(product, report, signal);
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        report.failure = { productId: product.supplySmartProductId, message };
        return report;
      }
    }
    report.next =
      products.length === input.limit ? (products.at(-1)?.supplySmartProductId ?? null) : null;
    return report;
  }

  private async one(
    product: RefreshedHealthFunctions,
    report: HealthFunctionCleanupReport,
    signal: AbortSignal,
  ) {
    const productId = product.supplySmartProductId;
    const stale = staleLinks(product, await this.deps.healthFunctions.list(productId, signal));
    report.checked += 1;
    report.removable += stale.length;
    for (const link of stale) {
      if (report.examples.length < 20) {
        report.examples.push({ productId, name: link.name });
      }
      if (!report.dryRun) {
        await this.deps.healthFunctions.unlink(productId, link.id, signal);
        report.removed += 1;
      }
    }
  }
}
