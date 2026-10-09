import { expect, it, vi } from "vitest";
import { BrandFamilyService } from "./family-service.js";
import { BrandSummaryService } from "./summary-service.js";
import { seededRuns } from "./testing/memory-runs.js";
import { companies, reviews, family, signal } from "./testing/fakes.js";

it("retains each family link conflict and continues the child with its existing owner", async () => {
  const store = await seededRuns();
  const company = companies();
  const review = reviews();
  company.link.mockResolvedValue({ status: "conflict", detail: { existingOwner: "existing" } });
  const check = vi.fn(async () => ({
    ...family,
    shape: "separate_sites" as const,
    subBrands: ["first", "second"].map((name) => ({
      name,
      url: `https://${name}.test`,
      isNutrition: true,
      evidence: { quote: "Our brands", url: "https://example.test/brands" },
    })),
  }));
  const result = await new BrandFamilyService({
    ...store,
    companies: company,
    reviews: review,
    family: { check },
    subBrandLimit: 20,
  }).check(store.runId, signal);
  expect(result.children).toHaveLength(2);
  for (const childRunId of result.children) {
    const child = await store.runs.get(childRunId);
    const conflict = await store.runs.step(childRunId, "ownership-conflict");
    expect(conflict).toMatchObject({
      link: { fromCompanyId: child?.companyId, toCompanyId: store.companyId },
      detail: { existingOwner: "existing" },
    });
    expect(
      await store.runs.step(store.runId, `ownership-conflict-${child?.companyId}`),
    ).toMatchObject({ childRunId });
    expect(await new BrandSummaryService(store).build(childRunId)).toMatchObject({
      ownership: "has_parent",
    });
    expect(await store.runs.clues(childRunId)).toEqual([]);
  }
  expect(review.addQuestion).not.toHaveBeenCalled();
  expect(company.link).toHaveBeenCalledTimes(2);
  expect(company.unlink).not.toHaveBeenCalled();
  expect(company.recordOwnershipCheck).not.toHaveBeenCalled();
  expect(await new BrandSummaryService(store).build(store.runId)).not.toHaveProperty("ownership");
});
