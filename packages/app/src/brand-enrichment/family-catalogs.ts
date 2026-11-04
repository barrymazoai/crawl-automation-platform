import { z } from "zod";
import { BrandEnrichmentSummarySchema } from "@crawl-automation/v3-contracts";
import { familyName } from "../site-analysis/family-names.js";
import type { SiteAnalysisService } from "../site-analysis/site-analysis-service.js";
import type { BrandEnrichmentRuns } from "./ports.js";
import { saveOutput } from "./run-records.js";
import { operationRequestId, productStep } from "./product-attempt.js";

const FamilySummarySchema = BrandEnrichmentSummarySchema.shape.family;

/**
 * Owner 2026-11-04 (KAN-253, Nature's Way): products read from a brand's own website. The site is the brand's, so its
 * catalogs name their brands, not the page vendor ("NW"); each catalog takes the family check's name for its
 * sub-brand, which is the Supply Smart company's name, so Supply Smart files the product under that sub-brand.
 */
export interface OwnSiteFamily {
  ownerBrand: string;
  /** Sub-brands the family check found and Supply Smart has a company for. */
  subBrands: string[];
}

export const OwnSiteFamilySchema = z.object({
  ownerBrand: z.string().min(1),
  subBrands: z.array(z.string().min(1)),
});

export async function ownSiteFamily(
  runs: BrandEnrichmentRuns,
  run: { runId: string; brandName: string },
): Promise<OwnSiteFamily> {
  const summary = FamilySummarySchema.safeParse(await runs.step(run.runId, "family-summary"));
  const subBrands =
    summary.success && summary.data
      ? summary.data.subBrands.flatMap((brand) => (brand.companyId ? [brand.name] : []))
      : [];
  return { ownerBrand: run.brandName, subBrands };
}

/** The brand each delivered source's products are sold under, in the family's own spelling. */
export function catalogBrandNames(
  tasks: readonly { sourceId: string; name: string }[],
  family: OwnSiteFamily,
): Record<string, string> {
  return Object.fromEntries(
    tasks.map((task) => [task.sourceId, familyName(task.name, family.subBrands) ?? task.name]),
  );
}

/**
 * Before the enqueueing apply: retain the family for redelivery, then give sources an earlier analysis stored
 * without the own-site mark that mark (settings history retained), so the apply matches them instead of skipping.
 */
export async function markOwnSiteSources(
  deps: { runs: BrandEnrichmentRuns; analyses: Pick<SiteAnalysisService, "apply"> },
  input: {
    runId: string;
    attempt: number;
    analysisId: string;
    catalogUrl: string | undefined;
    ownSite: OwnSiteFamily;
  },
) {
  const { runId, attempt, analysisId, catalogUrl, ownSite } = input;
  await saveOutput(deps.runs, {
    runId,
    step: productStep("product-own-site", attempt),
    output: ownSite,
  });
  await deps.analyses.apply({
    requestId: operationRequestId(runId, attempt === 1 ? "own-site" : `own-site@${attempt}`),
    analysisId,
    replaceSettings: true,
    family: ownSite,
    ...(catalogUrl ? { catalogUrl } : {}),
  });
}
