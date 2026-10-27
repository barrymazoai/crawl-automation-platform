import { isDeepStrictEqual } from "node:util";
import type { Queryable } from "@crawl-automation/platform";
import type { AnalyzedBrand } from "@crawl-automation/v3-contracts";
import { z } from "zod";

type SettingsInput = {
  sourceId: string;
  analysisId: string;
  brand: AnalyzedBrand;
  singleBrand: boolean;
};
const StoredKindSchema = z.object({ kind: z.enum(["single-brand", "multi-brand"]) });

function analyzedSettings(input: SettingsInput) {
  const { brand } = input;
  const site = {
    siteKey: brand.domain,
    platform: brand.platform,
    ...(brand.platform === "custom" ? { capture: "agent" } : {}),
  };
  return input.singleBrand
    ? { ...site, kind: "single-brand" as const, catalogUrl: brand.catalogUrl }
    : {
        ...site,
        kind: "multi-brand" as const,
        brands: [{ brand: brand.name, catalogUrl: brand.catalogUrl }],
      };
}

/**
 * Insert once for new or matched sources; never alter an existing source or its verified policy.
 * The site kind is the analysis's own answer (owner 2026-10-06): one brand on the domain is a single-brand store.
 */
export async function insertAnalyzedSettings(tx: Queryable, input: SettingsInput) {
  const { sourceId, analysisId } = input;
  const settings = analyzedSettings(input);
  const inserted = await tx.query(
    "INSERT INTO dtc_source_settings (source_id,analysis_id,settings) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING source_id",
    [sourceId, analysisId, JSON.stringify(settings)],
  );
  if (inserted.length) {
    return true;
  }
  const rows = await tx.query<{ settings: unknown }>(
    "SELECT settings FROM dtc_source_settings WHERE source_id=$1",
    [sourceId],
  );
  return isDeepStrictEqual(rows[0]?.settings, settings);
}

/** Caller holds the apply transaction. Keep the old policy before changing the current row. */
export async function replaceAnalyzedSettings(tx: Queryable, input: SettingsInput) {
  const rows = await tx.query<{ settings: unknown }>(
    "SELECT settings FROM dtc_source_settings WHERE source_id=$1 FOR UPDATE",
    [input.sourceId],
  );
  if (!rows[0]) {
    await insertAnalyzedSettings(tx, input);
    return null;
  }
  const previous = rows[0].settings;
  const settings = analyzedSettings(input);
  if (isDeepStrictEqual(previous, settings)) {
    return null;
  }
  const oldKind = StoredKindSchema.parse(previous).kind;
  await tx.query(
    `INSERT INTO dtc_source_settings_history
      (source_id,analysis_id,settings,replaced_by_analysis_id,reason)
     SELECT source_id,analysis_id,settings,$2,'owner-approved analysis reapply'
     FROM dtc_source_settings WHERE source_id=$1`,
    [input.sourceId, input.analysisId],
  );
  await tx.query(
    "UPDATE dtc_source_settings SET analysis_id=$2,settings=$3::jsonb WHERE source_id=$1",
    [input.sourceId, input.analysisId, JSON.stringify(settings)],
  );
  return { oldKind, newKind: settings.kind };
}

/**
 * A brand's own Shopify store lists every product at /collections/all. The analysis confirms the brand on whichever
 * collection it looked at (AfterDark's pre-workout, DryWater's hydration-powder, 2026-10-27), so a store submitted at
 * its home page scans the whole store; a submitted collection stays that collection.
 */
export function storeCatalog(
  brand: AnalyzedBrand,
  singleBrand: boolean,
  entryUrl: string,
): AnalyzedBrand {
  if (!singleBrand || brand.platform !== "shopify" || !brand.catalogUrl) {
    return brand;
  }
  const url = new URL(brand.catalogUrl);
  if (!/^\/collections(\/[^/]+)?\/?$/.test(url.pathname) || isCollection(entryUrl)) {
    return brand;
  }
  return { ...brand, catalogUrl: new URL("/collections/all", url).href };
}

function isCollection(url: string) {
  return new URL(url).pathname.startsWith("/collections/");
}

/** One brand on the domain in this analysis and no other brand's source there: a brand-owned store. */
export async function singleBrandSite(
  tx: Queryable,
  input: { brand: AnalyzedBrand; analysed: readonly AnalyzedBrand[] },
): Promise<boolean> {
  const { brand, analysed } = input;
  if (
    analysed.filter((other) => other.status === "verified" && other.domain === brand.domain)
      .length !== 1
  ) {
    return false;
  }
  const others = await tx.query(
    `SELECT 1 FROM dtc_source_settings settings JOIN brand_source source ON source.id=settings.source_id
    JOIN brand ON brand.id=source.brand_id
    WHERE settings.settings->>'siteKey'=$1 AND lower(brand.name)<>lower($2) LIMIT 1`,
    [brand.domain, brand.name],
  );
  return others.length === 0;
}

/**
 * A second brand never joins a domain stored as one brand's own store.
 * The collection the analysis looked at is this brand's own source, not a conflict, when storeCatalog widened it.
 */
export async function conflictingCatalog(
  tx: Queryable,
  brand: AnalyzedBrand,
  options: { observedUrl: string; allowMatchedCorrection: boolean },
): Promise<string | null> {
  const { observedUrl, allowMatchedCorrection } = options;
  const rows = await tx.query(
    `SELECT 1 FROM brand_source source JOIN brand ON brand.id=source.brand_id
    WHERE source.channel='dtc' AND (
      (source.url=ANY($1::text[]) AND lower(brand.name)<>lower($2)) OR
      (lower(brand.name)=lower($2) AND source.region='US' AND source.url<>ALL($1::text[])
        AND (source.url=$3 OR starts_with(source.url,$3 || '/'))))
    UNION ALL SELECT 1 FROM dtc_source_settings settings
      JOIN brand_source source ON source.id=settings.source_id
      JOIN brand owner ON owner.id=source.brand_id
      WHERE settings.settings->>'siteKey'=$4 AND settings.settings->>'platform'<>$5
        AND NOT ($6::boolean AND source.channel='dtc' AND source.region='US'
          AND source.url=ANY($1::text[]) AND lower(owner.name)=lower($2))
    UNION ALL SELECT 1 FROM dtc_source_settings settings JOIN brand_source source ON source.id=settings.source_id
      WHERE settings.settings->>'siteKey'=$4 AND source.url<>ALL($1::text[])
        AND settings.settings->>'kind'='single-brand' LIMIT 1`,
    [
      [brand.catalogUrl, observedUrl],
      brand.name,
      `https://${brand.domain}`,
      brand.domain,
      brand.platform,
      allowMatchedCorrection,
    ],
  );
  return rows.length
    ? "An existing source conflicts with this brand/domain catalog; preserved unchanged"
    : null;
}
