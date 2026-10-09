import {
  insertAnalyzedSettings,
  conflictingCatalog,
  singleBrandSite,
  storeCatalog,
} from "./site-analysis-settings.js";
import {
  siteAnalysisErrors,
  type SiteAnalysisApplyResult,
  type ApplySiteAnalysisSchema,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { AnalyzedBrandSchema, type AnalyzedBrand } from "@crawl-automation/v3-contracts";
import { z } from "zod";

type BrandApplication = {
  analysisId: string;
  brand: AnalyzedBrand;
  analysed: readonly AnalyzedBrand[];
  scoped: boolean;
};

export async function applySiteAnalysis(
  tx: Queryable,
  input: Omit<z.infer<typeof ApplySiteAnalysisSchema>, "requestId">,
): Promise<SiteAnalysisApplyResult> {
  const rows = await tx.query<Record<string, unknown>>(
    "SELECT state,brands FROM dtc_site_analysis WHERE id=$1 FOR UPDATE",
    [input.analysisId],
  );
  if (rows[0]?.["state"] !== "completed") {
    throw siteAnalysisErrors.create("SITE_ANALYSIS.NOT_APPLICABLE");
  }
  const brands = z.array(AnalyzedBrandSchema).parse(rows[0]?.["brands"]);
  const result: SiteAnalysisApplyResult = { created: [], matched: [], skipped: [] };
  const selected = input.brands?.map((name) => name.toLowerCase());
  skippedSelections(brands, input.brands ?? [], result);
  const catalogs = selectCatalog(brands, input.catalogUrl, result);
  for (const brand of catalogs.sort((left, right) =>
    left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
  )) {
    if (selected && !selected.includes(brand.name.toLowerCase())) {
      continue;
    }
    await applyBrand(
      tx,
      { analysisId: input.analysisId, brand, analysed: brands, scoped: !!input.catalogUrl },
      result,
    );
  }
  return result;
}

function selectCatalog(
  brands: AnalyzedBrand[],
  url: string | undefined,
  result: SiteAnalysisApplyResult,
) {
  return brands.filter((brand) => {
    if (url && brand.catalogUrl !== url) {
      result.skipped.push({ name: brand.name, reason: "Outside requested catalog" });
      return false;
    }
    return true;
  });
}

async function applyBrand(tx: Queryable, input: BrandApplication, result: SiteAnalysisApplyResult) {
  const { analysisId, brand: found } = input;
  if (found.status !== "verified" || !found.catalogUrl || found.name.length > 80) {
    result.skipped.push({
      name: found.name,
      reason: "Unverified catalog or brand name exceeds the brand record limit",
    });
    return;
  }
  // Serialize source creation across different analysis/request IDs for the same normalized brand.
  await tx.query<Record<string, unknown>>(
    "SELECT pg_advisory_xact_lock(hashtextextended(lower($1), 74))",
    [found.name],
  );
  // A collection-scoped analysis does not establish that the entire store belongs to this brand.
  const singleBrand = !input.scoped && (await singleBrandSite(tx, input));
  const brand = storeCatalog(found, singleBrand);
  const conflict = await conflictingCatalog(tx, brand);
  if (conflict) {
    result.skipped.push({ name: brand.name, reason: conflict });
    return;
  }
  const brandId = await matchBrand(tx, brand.name);
  const existing = await tx.query<Record<string, unknown>>(
    "SELECT id,channel FROM brand_source WHERE brand_id=$1 AND region='US' AND url=$2",
    [brandId, brand.catalogUrl],
  );
  if (existing[0]) {
    await matchSource(tx, { row: existing[0], brand, brandId, analysisId, singleBrand }, result);
    return;
  }
  const sourceId = await insertSource(tx, { brand, brandId, analysisId, singleBrand });
  result.created.push({ name: brand.name, brandId, sourceId });
}

async function insertSource(
  tx: Queryable,
  input: { brand: AnalyzedBrand; brandId: string; analysisId: string; singleBrand: boolean },
) {
  const { brand, brandId, analysisId, singleBrand } = input;
  const sources = await tx.query<Record<string, unknown>>(
    `INSERT INTO brand_source (brand_id,channel,region,url,enabled)
    VALUES ($1,'dtc','US',$2,true) RETURNING id`,
    [brandId, brand.catalogUrl],
  );
  const sourceId = z.uuid().parse(sources[0]?.["id"]);
  await insertAnalyzedSettings(tx, { sourceId, analysisId, brand, singleBrand });
  return sourceId;
}
async function matchBrand(tx: Queryable, name: string): Promise<string> {
  await tx.query<Record<string, unknown>>(
    "INSERT INTO brand (name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING",
    [name],
  );
  const rows = await tx.query<Record<string, unknown>>(
    "SELECT id FROM brand WHERE lower(name)=lower($1)",
    [name],
  );
  return z.uuid().parse(rows[0]?.["id"]);
}

function skippedSelections(
  brands: AnalyzedBrand[],
  names: string[],
  result: SiteAnalysisApplyResult,
) {
  for (const name of names) {
    if (!brands.some((brand) => brand.name.toLowerCase() === name.toLowerCase())) {
      result.skipped.push({ name, reason: "Name not present in this analysis" });
    }
  }
}

async function matchSource(
  tx: Queryable,
  input: {
    row: Record<string, unknown>;
    brand: AnalyzedBrand;
    brandId: string;
    analysisId: string;
    singleBrand: boolean;
  },
  result: SiteAnalysisApplyResult,
) {
  const { row, brand, brandId, analysisId, singleBrand } = input;
  if (row["channel"] !== "dtc") {
    result.skipped.push({ name: brand.name, reason: "Existing source belongs to another channel" });
    return;
  }
  const sourceId = z.uuid().parse(row["id"]);
  if (!(await insertAnalyzedSettings(tx, { sourceId, analysisId, brand, singleBrand }))) {
    result.skipped.push({
      name: brand.name,
      reason: "Existing source settings conflict; preserved unchanged",
    });
    return;
  }
  result.matched.push({ name: brand.name, brandId, sourceId });
}
