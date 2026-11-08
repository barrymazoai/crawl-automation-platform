import { errorCodeOf, recordRecovery, type Logger } from "@crawl-automation/platform";
import { z } from "zod";
import type { BrandScanStore } from "../brand-scans/ports.js";
import type { ScanChannel, ScanSource } from "../brand-scans/scan-model.js";
import type { BrandSourceImportStore } from "./source-import-store.js";

/** One call looks up at most 100 brands, so a request ends within minutes. */
export const LookedUpSourcesSchema = z.strictObject({
  sourceIds: z.array(z.uuid()).min(1).max(100),
});

export interface LookedUpSourceDeps {
  sources: Pick<BrandScanStore, "sources">;
  store: BrandSourceImportStore;
  channel: ScanChannel;
  /** Lookups in flight at once. */
  concurrency: number;
  /**
   * The brand's source on the target storefront, read from one archived page there; null when the storefront shows no
   * brand of that name. Site interpretation belongs to the injected channel functions, never to this service.
   */
  lookup(source: ScanSource, signal: AbortSignal): Promise<string | null>;
  log: Logger;
}

export interface LookedUpSourcesResult {
  created: number;
  existing: number;
  /** Requested ids that name no source. */
  missing: number;
  notFound: string[];
  failed: { brandName: string; code: string }[];
}

/**
 * KAN-243 (owner 2026-11-08): sources found by looking each brand up on another storefront, once per brand. Like
 * derived sources they are disabled and never enable or overwrite a row. A failed lookup is reported and the others go
 * on; it is never read as "not sold there".
 */
export class LookedUpBrandSources {
  constructor(private readonly deps: LookedUpSourceDeps) {}

  async import(raw: unknown, signal: AbortSignal): Promise<LookedUpSourcesResult> {
    const { sourceIds } = LookedUpSourcesSchema.parse(raw);
    const found = await this.deps.sources.sources([...new Set(sourceIds)]);
    const brands = [...new Map(found.map((source) => [source.brandId, source])).values()];
    const rows: { brandId: string; channel: ScanChannel; url: string }[] = [];
    const result: LookedUpSourcesResult = {
      created: 0,
      existing: 0,
      missing: new Set(sourceIds).size - found.length,
      notFound: [],
      failed: [],
    };
    await eachAtOnce(brands, this.deps.concurrency, async (source) => {
      try {
        const url = await this.deps.lookup(source, signal);
        if (url) {
          rows.push({ brandId: source.brandId, channel: this.deps.channel, url });
        } else {
          result.notFound.push(source.brandName);
        }
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        recordRecovery(error, { operation: `${this.deps.channel}.source-lookup` });
        result.failed.push({ brandName: source.brandName, code: errorCodeOf(error) ?? "UNKNOWN" });
      }
    });
    const written = rows.length ? await this.deps.store.addDisabledSources(rows) : null;
    this.deps.log.info(
      {
        channel: this.deps.channel,
        brands: brands.length,
        found: rows.length,
        failed: result.failed.length,
      },
      "brand sources looked up",
    );
    return { ...result, created: written?.created ?? 0, existing: written?.existing ?? 0 };
  }
}

/** Runs `work` over every item with at most `limit` in flight. */
async function eachAtOnce<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
