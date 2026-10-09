import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrandFamilyService } from "./family-service.js";
import { BrandSummaryService } from "./summary-service.js";
import { companies, reviews, family, signal } from "./testing/fakes.js";
import { seededRuns } from "./testing/memory-runs.js";

it.each(["separate_sites", "shared_site"] as const)(
  "only links an existing sub-brand under a %s group",
  async (shape) => {
    const store = await seededRuns();
    const company = companies();
    const companyId = randomUUID();
    company.resolveDomain.mockResolvedValue({
      status: "matched",
      companyId,
      companyName: "Existing",
      candidates: [],
      reason: "domain",
    });
    company.resolve.mockResolvedValue({
      status: "matched",
      companyId,
      matchedBy: "name",
      matches: [],
      reason: "name",
    });
    const check = vi.fn(async () => ({
      ...family,
      shape,
      subBrands: [
        {
          name: "Existing",
          url: "https://existing.test",
          isNutrition: true,
          evidence: { quote: "Our brand", url: "https://example.test/brands" },
        },
      ],
    }));
    const result = await new BrandFamilyService({
      ...store,
      companies: company,
      reviews: reviews(),
      family: { check },
      subBrandLimit: 20,
    }).check(store.runId, signal);
    expect(result.children).toEqual([]);
    expect(await store.runs.list({ parentRunId: store.runId, limit: 100 })).toEqual([]);
    expect(company.link).toHaveBeenCalledExactlyOnceWith(
      {
        fromCompanyId: companyId,
        toCompanyId: store.companyId,
        kind: "brand_of",
        confidence: 1,
      },
      signal,
    );
    expect(company.create).not.toHaveBeenCalled();
    expect(company.enrich).not.toHaveBeenCalled();
    expect(company.recordOwnershipCheck).not.toHaveBeenCalled();
    expect(await new BrandSummaryService(store).build(store.runId)).toMatchObject({
      family: { subBrands: [{ name: "Existing", companyId, status: "completed" }] },
    });
  },
);
