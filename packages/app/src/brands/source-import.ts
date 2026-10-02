export * from "./derived-sources.js";
import { DerivedBrandSources, type DerivedSourceDeps } from "./derived-sources.js";
import { appErrors } from "../errors.js";
import { recordRecovery } from "@crawl-automation/platform";
import { brandScanErrors, type ChannelRegistry } from "@crawl-automation/channels-core";
import { errorCodeOf, type Logger } from "@crawl-automation/platform";
import { z } from "zod";
import type { BrowserBrandScanners } from "../brand-scans/ports.js";
import { sourceUrlOf } from "../brand-scans/scan-listing.js";
import { ScanChannelSchema, type ScanChannel } from "../brand-scans/scan-model.js";
import type { BrandName, BrandSourceImportStore } from "./source-import-store.js";
import { assertSourcePolicy } from "./source-policy.js";
export type { BrandName, BrandSourceImportStore } from "./source-import-store.js";

/** A channel's brand list, as the site's brand directory shows it (name and brand listing URL). */
export const ImportSourcesSchema = z.strictObject({
  channel: ScanChannelSchema,
  entries: z
    .array(z.strictObject({ name: z.string().min(1).max(200), url: z.url().max(2000) }))
    .min(1)
    .max(2_000),
});
export type ImportSources = z.infer<typeof ImportSourcesSchema>;
type Entry = ImportSources["entries"][number];

export interface SourceImportResult {
  created: number;
  existing: number;
  /** The site's name matched no brand exactly, but one or more after ignoring case, marks and punctuation. */
  looseMatches: (Entry & { candidates: string[] })[];
  unmatched: Entry[];
  /** Not this channel's brand listing URL. */
  refused: (Entry & { code: string })[];
}

/** Lower case, trademark marks dropped, `&` as `and`, and only letters and digits kept. */
const looseKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");

/**
 * Imports a channel's brand directory as brand sources: an exact (case-insensitive) name match becomes a disabled
 * source, to be enabled by hand; loose and missing matches come back as a review list, never guessed.
 */
export class BrandSourceImport {
  constructor(
    private readonly deps: {
      store: BrandSourceImportStore;
      derived?: DerivedSourceDeps;
      registry: ChannelRegistry;
      browsers: BrowserBrandScanners;
      log: Logger;
    },
  ) {}

  /** Derives Whole Foods sources from retained Amazon source records; no network or scan is started. */
  deriveWholeFoods(raw: unknown): Promise<{ created: number; skipped: number }> {
    if (!this.deps.derived) {
      throw appErrors.create("BRAND_SCAN.NOT_CONFIGURED");
    }
    return new DerivedBrandSources(this.deps.derived).import(raw);
  }

  async import(raw: unknown): Promise<SourceImportResult> {
    const { channel, entries } = ImportSourcesSchema.parse(raw);
    const sourceUrl = sourceUrlOf(this.deps, channel);
    const normalise = (entry: Entry) => {
      assertSourcePolicy(this.deps.registry, { channel, url: entry.url, brandName: entry.name });
      return sourceUrl(entry.url);
    };
    const brands = await this.deps.store.brandNames();
    const exact = new Map(brands.map((brand) => [brand.name.toLowerCase(), brand]));
    const result: SourceImportResult = {
      created: 0,
      existing: 0,
      looseMatches: [],
      unmatched: [],
      refused: [],
    };
    const rows: { brandId: string; channel: ScanChannel; url: string }[] = [];
    for (const entry of entries) {
      const url = this.sourceUrl(normalise, entry, result);
      const brand = url ? exact.get(entry.name.toLowerCase()) : undefined;
      if (url && brand) {
        rows.push({ brandId: brand.brandId, channel, url });
      } else if (url) {
        this.review(entry, brands, result);
      }
    }
    const written =
      rows.length > 0
        ? await this.deps.store.addDisabledSources(rows)
        : { created: 0, existing: 0 };
    this.deps.log.info(
      { channel, ...written, loose: result.looseMatches.length },
      "brand sources imported",
    );
    return { ...result, ...written };
  }

  private sourceUrl(normalise: (entry: Entry) => string, entry: Entry, result: SourceImportResult) {
    try {
      return normalise(entry);
    } catch (error) {
      recordRecovery(error, { operation: "source-import" });
      result.refused.push({
        ...entry,
        code: errorCodeOf(error) ?? brandScanErrors.code("BRAND_SCAN.URL"),
      });
      return null;
    }
  }

  private review(entry: Entry, brands: readonly BrandName[], result: SourceImportResult): void {
    const key = looseKey(entry.name);
    const candidates = brands
      .filter((brand) => key && looseKey(brand.name) === key)
      .map((brand) => brand.name);
    if (candidates.length > 0) {
      result.looseMatches.push({ ...entry, candidates });
    } else {
      result.unmatched.push(entry);
    }
  }
}
