import { isDeepStrictEqual } from "node:util";
import type { Queryable } from "@crawl-automation/platform";
import type { AnalyzedBrand } from "@crawl-automation/v3-contracts";

/**
 * Insert once for new or matched sources; never alter an existing source or its verified policy.
 * The site kind is the analysis's own answer (owner 2026-10-06): one brand on the domain is a single-brand store.
 */
export async function insertAnalyzedSettings(
  tx: Queryable,
  input: { sourceId: string; analysisId: string; brand: AnalyzedBrand; singleBrand: boolean },
) {
  const { sourceId, analysisId, brand } = input;
  const site = { siteKey: brand.domain, platform: brand.platform };
  const settings = input.singleBrand
    ? { ...site, kind: "single-brand", catalogUrl: brand.catalogUrl }
    : {
        ...site,
        kind: "multi-brand",
        brands: [{ brand: brand.name, catalogUrl: brand.catalogUrl }],
      };
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

/** A brand's own Shopify store lists every product at /collections/all, never at the bare collection index. */
export function storeCatalog(brand: AnalyzedBrand, singleBrand: boolean): AnalyzedBrand {
  if (!singleBrand || brand.platform !== "shopify" || !brand.catalogUrl) {
    return brand;
  }
  const url = new URL(brand.catalogUrl);
  if (url.pathname.replace(/\/$/, "") !== "/collections" || url.search) {
    return brand;
  }
  return { ...brand, catalogUrl: new URL("/collections/all", url).href };
}

/** One brand on the domain in this analysis and no other brand's source there: a brand-owned store. */
export async function singleBrandSite(
  tx: Queryable,
  input: { brand: AnalyzedBrand; analysed: readonly AnalyzedBrand[] },
): Promise<boolean> {
  const { brand, analysed } = input;
  if (analysed.filter((other) => other.domain === brand.domain).length !== 1) {
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

/** A second brand never joins a domain stored as one brand's own store. */
export async function conflictingCatalog(
  tx: Queryable,
  brand: AnalyzedBrand,
): Promise<string | null> {
  const rows = await tx.query(
    `SELECT 1 FROM brand_source source JOIN brand ON brand.id=source.brand_id
    WHERE source.channel='dtc' AND (
      (source.url=$1 AND lower(brand.name)<>lower($2)) OR
      (lower(brand.name)=lower($2) AND source.region='US' AND source.url<>$1
        AND (source.url=$3 OR starts_with(source.url,$3 || '/'))))
    UNION ALL SELECT 1 FROM dtc_source_settings
      WHERE settings->>'siteKey'=$4 AND settings->>'platform'<>$5
    UNION ALL SELECT 1 FROM dtc_source_settings settings JOIN brand_source source ON source.id=settings.source_id
      WHERE settings.settings->>'siteKey'=$4 AND source.url<>$1
        AND settings.settings->>'kind'='single-brand' LIMIT 1`,
    [brand.catalogUrl, brand.name, `https://${brand.domain}`, brand.domain, brand.platform],
  );
  return rows.length
    ? "An existing source conflicts with this brand/domain catalog; preserved unchanged"
    : null;
}
