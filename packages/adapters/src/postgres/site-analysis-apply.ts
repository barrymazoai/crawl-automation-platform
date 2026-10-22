import { conflictingCatalog, singleBrandSite, storeCatalog } from "./site-analysis-settings.js";
import { applyAnalyzedSource } from "./site-analysis-source.js";
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
  replaceSettings: boolean;
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
  const result: SiteAnalysisApplyResult = { created: [], matched: [], corrected: [], skipped: [] };
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
      {
        analysisId: input.analysisId,
        brand,
        analysed: brands,
        scoped: !!input.catalogUrl,
        replaceSettings: input.replaceSettings === true,
      },
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
  const { brand: found } = input;
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
  const conflict = await conflictingCatalog(tx, brand, input.replaceSettings);
  if (conflict) {
    result.skipped.push({ name: brand.name, reason: conflict });
    return;
  }
  await applyAnalyzedSource(
    tx,
    {
      brand,
      analysisId: input.analysisId,
      singleBrand,
      replaceSettings: input.replaceSettings,
    },
    result,
  );
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
