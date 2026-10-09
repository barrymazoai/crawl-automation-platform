import type {
  BrandEnrichmentRun,
  FamilyFinding,
  BrandEnrichmentSummary,
  CompanyLink,
} from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns, BrandEnrichmentReviews, SupplySmartCompanies } from "./ports.js";
import { childRun, domainOf, saveOutput } from "./run-records.js";
import { resolvedCompany } from "./company-resolution.js";
import { brandEnrichmentErrors } from "./errors.js";
import { saveOwnershipConflict } from "./ownership-conflict.js";

type Parent = BrandEnrichmentRun & { companyId: string };
type SubBrand = FamilyFinding["subBrands"][number];
type Summary = NonNullable<BrandEnrichmentSummary["family"]>;
export class BrandFamilyChildren {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      reviews: BrandEnrichmentReviews;
      companies: SupplySmartCompanies;
      subBrandLimit: number;
    },
  ) {}
  async prepare(input: { run: Parent; finding: FamilyFinding }, signal: AbortSignal) {
    const { run, finding } = input;
    const summary: Summary = { shape: finding.shape, subBrands: [] };
    const children: string[] = [];
    let admitted = 0;
    for (const brand of finding.shape === "single" ? [] : finding.subBrands) {
      if (!brand.isNutrition || admitted >= Math.min(20, this.deps.subBrandLimit)) {
        summary.subBrands.push({
          name: brand.name,
          status: brand.isNutrition ? "over_limit" : "skipped_not_nutrition",
        });
        continue;
      }
      admitted++;
      try {
        const child = await this.prepareChild(
          { run, brand, shared: finding.shape === "shared_site" },
          signal,
        );
        summary.subBrands.push({
          name: brand.name,
          companyId: child.companyId,
          status: child.conflict ? "failed" : "completed",
        });
        if (child.runId) {
          children.push(child.runId);
        }
      } catch (error) {
        signal.throwIfAborted();
        summary.subBrands.push({ name: brand.name, status: "failed" });
        await saveOutput(this.deps.runs, {
          runId: run.runId,
          step: `family-failure-${admitted}`,
          output: { name: brand.name, reason: String(error) },
        });
      }
    }
    return { summary, children };
  }
  private async prepareChild(
    input: { run: Parent; brand: SubBrand; shared: boolean },
    signal: AbortSignal,
  ) {
    const { run, brand, shared } = input;
    const { company, existing } = await this.resolve(brand, shared, signal);
    if (company.id === run.companyId) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED");
    }
    const link = {
      fromCompanyId: company.id,
      toCompanyId: run.companyId,
      kind: "brand_of" as const,
      confidence: 1,
    };
    const linked = await this.deps.companies.link(link, signal);
    if (existing) {
      if (linked.status === "conflict") {
        await saveOutput(this.deps.runs, {
          runId: run.runId,
          step: `ownership-conflict-${company.id}`,
          output: { link, detail: linked.detail },
        });
      }
      return { companyId: company.id, runId: null, conflict: linked.status === "conflict" };
    }
    return this.newChild({ run, brand, shared, link, linked }, signal);
  }
  private async newChild(
    input: {
      run: Parent;
      brand: SubBrand;
      shared: boolean;
      link: CompanyLink;
      linked: Awaited<ReturnType<SupplySmartCompanies["link"]>>;
    },
    signal: AbortSignal,
  ) {
    const { run, brand, shared, link, linked } = input;
    const child = await childRun(this.deps.runs, {
      parent: run,
      role: "sub_brand",
      name: brand.name,
      url: shared ? null : brand.url,
      companyId: link.fromCompanyId,
    });
    if (linked.status === "conflict") {
      await saveOwnershipConflict(this.deps.runs, {
        runId: child.runId,
        link,
        detail: linked.detail,
      });
      await saveOutput(this.deps.runs, {
        runId: run.runId,
        step: `ownership-conflict-${link.fromCompanyId}`,
        output: { childRunId: child.runId, link, detail: linked.detail },
      });
      return { ...child, conflict: false };
    }
    await this.recordLink({ child, run, brand }, signal);
    return { ...child, conflict: false };
  }
  private async recordLink(
    input: { child: BrandEnrichmentRun; run: Parent; brand: SubBrand },
    signal: AbortSignal,
  ) {
    const { child, run, brand } = input;
    await this.deps.runs.addClues(child.runId, [
      {
        signal: "website_our_brands",
        ownerName: run.brandName,
        ownerDomain: domainOf(run.brandUrl),
        ownerCompanyId: run.companyId,
        quote: brand.evidence.quote,
        url: brand.evidence.url,
        archiveKey: null,
      },
    ]);
    await this.deps.companies.recordOwnershipCheck(
      {
        companyId: child.companyId as string,
        result: "has_parent",
        signals: ["website_our_brands"],
      },
      signal,
    );
  }
  private async resolve(brand: SubBrand, shared: boolean, signal: AbortSignal) {
    const domain = shared ? null : domainOf(brand.url);
    if (!shared && !domain) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED");
    }
    const resolution = domain
      ? await this.deps.companies.resolveDomain(domain, signal)
      : await this.deps.companies.resolve({ name: brand.name }, signal);
    const company = await resolvedCompany(
      this.deps.companies,
      {
        resolution,
        create: {
          name: brand.name,
          isNutrition: true,
          ...(domain ? { website: `https://${domain}` } : {}),
        },
      },
      signal,
    );
    return { company, existing: resolution.status === "matched" };
  }
}
