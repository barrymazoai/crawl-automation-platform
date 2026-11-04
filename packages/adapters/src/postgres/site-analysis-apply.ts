import { conflictingCatalog, singleBrandSite, storeCatalog } from "./site-analysis-settings.js";
import { applyAnalyzedSource } from "./site-analysis-source.js";
import {
  familyName,
  siteAnalysisErrors,
  siteAnalysisLimitsReached,
  type SiteAnalysisApplyResult,
  type ApplySiteAnalysisSchema,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import {
  AnalyzedBrandSchema,
  SiteAnalysisLimitsSchema,
  type AnalyzedBrand,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";

type BrandApplication = {
  analysisId: string;
  brand: AnalyzedBrand;
  analysed: readonly AnalyzedBrand[];
  /** The page the analysis was asked to look at. */
  entryUrl: string;
  scoped: boolean;
  replaceSettings: boolean;
  family: z.infer<typeof ApplySiteAnalysisSchema>["family"];
};

export async function applySiteAnalysis(
  tx: Queryable,
  input: Omit<z.infer<typeof ApplySiteAnalysisSchema>, "requestId">,
  onState?: (state: "completed" | "needs-review") => void,
): Promise<SiteAnalysisApplyResult> {
  const result: SiteAnalysisApplyResult = { created: [], matched: [], corrected: [], skipped: [] };
  const { brands, applicable, state, entryUrl } = await applicableBrands(
    tx,
    input.analysisId,
    result,
  );
  onState?.(state);
  const selected = input.brands?.map((name) => name.toLowerCase());
  skippedSelections(brands, input.brands ?? [], result);
  const catalogs = selectCatalog(applicable, input.catalogUrl, result);
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
        analysed: applicable,
        entryUrl,
        scoped: !!input.catalogUrl,
        replaceSettings: input.replaceSettings === true,
        family: input.family,
      },
      result,
    );
  }
  return result;
}

async function applicableBrands(
  tx: Queryable,
  analysisId: string,
  result: SiteAnalysisApplyResult,
) {
  const rows = await tx.query<Record<string, unknown>>(
    "SELECT state,brands,limits,reasons,url FROM dtc_site_analysis WHERE id=$1 FOR UPDATE",
    [analysisId],
  );
  const row = rows[0];
  if (!row || (row["state"] !== "completed" && row["state"] !== "needs-review")) {
    throw siteAnalysisErrors.create("SITE_ANALYSIS.NOT_APPLICABLE");
  }
  const state = row["state"] as "completed" | "needs-review";
  const brands = z.array(AnalyzedBrandSchema).parse(row["brands"]);
  if (
    siteAnalysisLimitsReached({
      brands,
      limits: SiteAnalysisLimitsSchema.parse(row["limits"]),
      reasons: z.array(z.string()).parse(row["reasons"]),
    })
  ) {
    throw siteAnalysisErrors.create("SITE_ANALYSIS.NOT_APPLICABLE");
  }
  const applicable =
    state === "needs-review"
      ? brands.filter((brand) => {
          if (brand.status === "verified") {
            return true;
          }
          result.skipped.push({
            name: brand.name,
            reason: `Brand not verified in this analysis: ${brand.reason ?? "No reason provided"}`,
          });
          return false;
        })
      : brands;
  return { brands, applicable, state, entryUrl: z.string().parse(row["url"]) };
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
  const found = await familyBrand(tx, input);
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
  const brand = storeCatalog(found, singleBrand, input.entryUrl);
  const conflict = await conflictingCatalog(tx, brand, {
    observedUrl: found.catalogUrl,
    allowMatchedCorrection: input.replaceSettings,
  });
  if (conflict) {
    result.skipped.push({ name: brand.name, reason: conflict });
    return;
  }
  await applyAnalyzedSource(
    tx,
    {
      brand,
      observedUrl: found.catalogUrl,
      analysisId: input.analysisId,
      singleBrand,
      replaceSettings: input.replaceSettings,
      ...(input.family && !singleBrand ? { ownerBrand: input.family.ownerBrand } : {}),
    },
    result,
  );
}

/**
 * KAN-253: on a family's own site one name per catalog. An existing DTC source of the same catalog URL keeps its
 * brand; otherwise the family check's sub-brand name; otherwise the analysis's own name.
 */
async function familyBrand(tx: Queryable, input: BrandApplication): Promise<AnalyzedBrand> {
  const { brand, family } = input;
  if (!family || brand.status !== "verified" || !brand.catalogUrl) {
    return brand;
  }
  const rows = await tx.query<{ name: string }>(
    `SELECT brand.name FROM brand_source source JOIN brand ON brand.id=source.brand_id
    WHERE source.channel='dtc' AND source.region='US' AND source.url=$1 ORDER BY source.created_at LIMIT 2`,
    [brand.catalogUrl],
  );
  const existing = rows.length === 1 ? rows[0]?.name : undefined;
  const name = existing ?? familyName(brand.name, family.subBrands) ?? brand.name;
  return name === brand.name ? brand : { ...brand, name };
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
