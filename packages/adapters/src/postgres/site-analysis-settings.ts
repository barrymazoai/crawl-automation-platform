import { isDeepStrictEqual } from "node:util";
import type { Queryable } from "@crawl-automation/platform";
import type { AnalyzedBrand } from "@crawl-automation/v3-contracts";

/** Insert once for new or matched sources; never alter an existing source or its verified policy. */
export async function insertAnalyzedSettings(
  tx: Queryable,
  input: { sourceId: string; analysisId: string; brand: AnalyzedBrand },
) {
  const { sourceId, analysisId, brand } = input;
  const settings = {
    siteKey: brand.domain,
    platform: brand.platform,
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
      WHERE settings->>'siteKey'=$4 AND settings->>'platform'<>$5 LIMIT 1`,
    [brand.catalogUrl, brand.name, `https://${brand.domain}`, brand.domain, brand.platform],
  );
  return rows.length
    ? "An existing source conflicts with this brand/domain catalog; preserved unchanged"
    : null;
}
