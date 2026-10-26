import { z } from "zod";
import type { ProductSyncLedger, RefreshedEnrichment } from "./ledger.js";

/** A dry run by default: Supply Smart runs every change and rolls it back, so the report is exact. */
export const UpdateEnrichmentSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  /** The previous answer's `next` (a Supply Smart product ID). */
  after: z.uuid().optional(),
  dryRun: z.boolean().default(true),
});
export type UpdateEnrichment = z.input<typeof UpdateEnrichmentSchema>;

/** One product's change, as `product.updateEnrichment` takes it. */
export interface EnrichmentChange {
  productId: string;
  add: { productForm?: string; healthFunctions: string[]; mainIngredients: string[] };
  remove: { forms: string[]; healthFunctions: string[]; mainIngredients: string[] };
}

type Kind = "forms" | "healthFunctions" | "mainIngredients";
export type EnrichmentOutcome =
  | { productId: string; ok: true; added: Record<Kind, string[]>; removed: Record<Kind, string[]> }
  | { productId: string; ok: false; code: string; message: string };

export interface SupplySmartEnrichment {
  /** `product.updateEnrichmentBatch`: each product its own transaction; one failing leaves the others alone. */
  update(
    changes: EnrichmentChange[],
    dryRun: boolean,
    signal: AbortSignal,
  ): Promise<EnrichmentOutcome[]>;
}

export interface EnrichmentUpdateReport {
  dryRun: boolean;
  /** Products this page read from the ledger. */
  checked: number;
  /** Already up to date: sent after the current enrichment and nothing earlier to take back. */
  skipped: number;
  /** Sent to Supply Smart (with `dryRun`: previewed). */
  updated: number;
  /** Links added and removed in Supply Smart (with `dryRun`: that would be). */
  added: Record<Kind, number>;
  removed: Record<Kind, number>;
  /** Up to 20 products with what changed. */
  examples: { productId: string; added: Record<Kind, string[]>; removed: Record<Kind, string[]> }[];
  /** Products Supply Smart refused (404, 500); the others in the page still ran. */
  failures: { productId: string; code: string; message: string }[];
  /** Pass as `after` for the next page; null when this page was the last. */
  next: string | null;
}

/** Supply Smart compares names with whitespace collapsed, case-insensitively. */
const normalized = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

const without = (names: string[], kept: string[]) => {
  const keep = new Set(kept.map(normalized));
  return [...new Set(names)].filter((name) => !keep.has(normalized(name)));
};

/**
 * What one product should change: the current enrichments' names are added (Supply Smart keeps a name already
 * linked), and the names earlier enrichments of the same listings sent and no current one sends are removed. A name
 * the crawler never sent is never removed. Null when there is nothing to do.
 */
export function enrichmentChange(product: RefreshedEnrichment): EnrichmentChange | null {
  const { current, previous } = product;
  const remove = {
    forms: without(previous.forms, current.forms),
    healthFunctions: without(previous.healthFunctions, current.healthFunctions),
    mainIngredients: without(previous.mainIngredients, current.mainIngredients),
  };
  const removes = Object.values(remove).some((names) => names.length);
  if (!product.sentBeforeCurrent && !removes) {
    return null;
  }
  return {
    productId: product.supplySmartProductId,
    add: {
      // Supply Smart takes one form per call: the newest current enrichment's.
      ...(current.forms[0] ? { productForm: current.forms[0] } : {}),
      healthFunctions: [...new Set(current.healthFunctions)].slice(0, 30),
      mainIngredients: [...new Set(current.mainIngredients)].slice(0, 50),
    },
    remove: {
      forms: remove.forms.slice(0, 50),
      healthFunctions: remove.healthFunctions.slice(0, 50),
      mainIngredients: remove.mainIngredients.slice(0, 50),
    },
  };
}

const zero = (): Record<Kind, number> => ({ forms: 0, healthFunctions: 0, mainIngredients: 0 });
const kinds: Kind[] = ["forms", "healthFunctions", "mainIngredients"];

/**
 * Brings the form, health functions and main ingredients of products already in Supply Smart up to their current
 * enrichment (product-enrichment/4, owner 2026-10-26) through `product.updateEnrichmentBatch`: a resent ingest is
 * refused there (idempotency_conflict) and ingest only ever adds. One page of products in Supply Smart ID order per
 * call. Pattern: Command with a dry-run preview.
 */
export class EnrichmentUpdate {
  constructor(
    private readonly deps: {
      ledger: Pick<ProductSyncLedger, "refreshedEnrichments">;
      supplySmart: SupplySmartEnrichment;
    },
  ) {}

  async run(
    raw: UpdateEnrichment,
    signal = new AbortController().signal,
  ): Promise<EnrichmentUpdateReport> {
    const input = UpdateEnrichmentSchema.parse(raw);
    const products = await this.deps.ledger.refreshedEnrichments({
      ...(input.after ? { after: input.after } : {}),
      limit: input.limit,
    });
    const changes = products.map(enrichmentChange).filter((change) => change !== null);
    const report: EnrichmentUpdateReport = {
      dryRun: input.dryRun,
      checked: products.length,
      skipped: products.length - changes.length,
      updated: 0,
      added: zero(),
      removed: zero(),
      examples: [],
      failures: [],
      next:
        products.length === input.limit ? (products.at(-1)?.supplySmartProductId ?? null) : null,
    };
    const outcomes = changes.length
      ? await this.deps.supplySmart.update(changes, input.dryRun, signal)
      : [];
    tally(report, outcomes);
    return report;
  }
}

function tally(report: EnrichmentUpdateReport, outcomes: EnrichmentOutcome[]) {
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      const { productId, code, message } = outcome;
      report.failures.push({ productId, code, message });
      continue;
    }
    report.updated += 1;
    for (const kind of kinds) {
      report.added[kind] += outcome.added[kind].length;
      report.removed[kind] += outcome.removed[kind].length;
    }
    const changed = kinds.some((kind) => outcome.added[kind].length + outcome.removed[kind].length);
    if (changed && report.examples.length < 20) {
      const { productId, added, removed } = outcome;
      report.examples.push({ productId, added, removed });
    }
  }
}
