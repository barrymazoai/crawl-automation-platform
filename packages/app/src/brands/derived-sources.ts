import { z } from "zod";
import type { BrandScanStore } from "../brand-scans/ports.js";
import type { ScanChannel, ScanSource } from "../brand-scans/scan-model.js";
import type { BrandSourceImportStore } from "./source-import-store.js";

export const DerivedSourcesSchema = z.strictObject({
  sourceIds: z.array(z.uuid()).min(1).max(2_000),
});

export interface DerivedSourceDeps {
  sources: Pick<BrandScanStore, "sources">;
  store: BrandSourceImportStore;
  channel: ScanChannel;
  /** Site interpretation belongs to the injected channel functions, never to this service. */
  derive(source: ScanSource): string | null;
}

/** Derived sources are disabled, deduplicated by brand and URL, and never enable or overwrite a row. */
export class DerivedBrandSources {
  constructor(private readonly deps: DerivedSourceDeps) {}

  async import(raw: unknown): Promise<{ created: number; skipped: number }> {
    const { sourceIds } = DerivedSourcesSchema.parse(raw);
    const sources = await this.deps.sources.sources([...new Set(sourceIds)]);
    const rows = new Map<string, { brandId: string; channel: ScanChannel; url: string }>();
    for (const source of sources) {
      const url = this.deps.derive(source);
      if (url) {
        rows.set(`${source.brandId}\0${url}`, {
          brandId: source.brandId,
          channel: this.deps.channel,
          url,
        });
      }
    }
    const result = rows.size
      ? await this.deps.store.addDisabledSources([...rows.values()])
      : { created: 0 };
    // Each requested entry counts once: invalid, absent, duplicate and existing entries are skipped.
    return { created: result.created, skipped: sourceIds.length - result.created };
  }
}
