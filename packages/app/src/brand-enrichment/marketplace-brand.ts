import { BrandWebsiteSchema } from "@crawl-automation/v3-contracts";
import { brandCompanyDomain } from "../product-sync/brand-company-model.js";
import type { BrandCompanyRepository } from "../product-sync/ports.js";
import { brandEnrichmentErrors } from "./errors.js";
import type { BrandEnrichmentRuns, MarketplaceBrands } from "./ports.js";
import { requireCompanyRun, requireRun, saveOutput } from "./run-records.js";
import type { WebsiteFinder } from "./task-ports.js";

/** Product pages handed to the website lookup as hints. */
const LISTING_HINTS = 5;

async function requireMarketplaceRun(runs: BrandEnrichmentRuns, runId: string) {
  const run = await requireRun(runs, runId);
  if (run.role !== "marketplace" || !run.brandId) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE", {
      details: { runId, role: run.role },
    });
  }
  return { ...run, brandId: run.brandId };
}

/**
 * First step of a `marketplace` run (owner 2026-10-15): Codex finds the brand's official website. With one, the run
 * continues with the usual identity rule; without one, nothing is created and the brand keeps waiting.
 */
export class BrandWebsiteService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      brands: Pick<MarketplaceBrands, "listings">;
      finder: WebsiteFinder;
    },
  ) {}
  async find(runId: string, signal: AbortSignal) {
    const run = await requireMarketplaceRun(this.deps.runs, runId);
    await this.deps.runs.update(runId, { stage: "website" });
    const listings = await this.deps.brands.listings(run.brandId, LISTING_HINTS);
    const website = BrandWebsiteSchema.parse(
      await this.deps.finder.find(
        { runId, brandName: run.brandName, brandUrl: null, listings },
        signal,
      ),
    );
    await saveOutput(this.deps.runs, {
      runId,
      step: "website",
      output: website,
      archiveKeys: website.archiveKeys,
    });
    if (!website.url) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.WEBSITE_NOT_FOUND", {
        details: { runId, reason: website.reason },
      });
    }
    await this.deps.runs.update(runId, { brandUrl: website.url });
    return { url: website.url };
  }
}

/**
 * Last step of a `marketplace` run: the company the identity step found or created becomes the brand's match, so
 * the product sync sends the brand's waiting products. The domain is the website that resolved to that company.
 */
export class MarketplaceMatchService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      matches: Pick<BrandCompanyRepository, "upsert">;
      now?: () => Date;
    },
  ) {}
  async record(runId: string) {
    const run = await requireCompanyRun(this.deps.runs, runId);
    const { brandId } = await requireMarketplaceRun(this.deps.runs, runId);
    const domain = brandCompanyDomain(run.brandUrl);
    if (!domain) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE", {
        details: { runId, reason: "website_missing" },
      });
    }
    const match = {
      brandId,
      status: "matched" as const,
      companyId: run.companyId,
      domain,
      matchedBy: "website",
      candidates: [],
      checkedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    await this.deps.matches.upsert(match);
    await saveOutput(this.deps.runs, { runId, step: "marketplace-match", output: match });
    return match;
  }
}
