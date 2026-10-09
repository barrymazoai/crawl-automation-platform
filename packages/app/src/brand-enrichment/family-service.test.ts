import { expect, it, vi } from "vitest";
import { BrandFamilyService } from "./family-service.js";
import { seededRuns } from "./testing/memory-runs.js";
import { companies, reviews, family, signal } from "./testing/fakes.js";

it("limits nutrition children to twenty, lists exclusions, and links every separate site before its child run", async () => {
  const store = await seededRuns();
  const company = companies();
  const check = vi.fn(async () => ({
    ...family,
    shape: "separate_sites" as const,
    subBrands: Array.from({ length: 23 }, (_, index) => ({
      name: `Brand ${index}`,
      url: `https://brand${index}.test`,
      isNutrition: index !== 0,
      evidence: { quote: "Our brand", url: "https://example.test/brands" },
    })),
  }));
  const service = new BrandFamilyService({
    runs: store.runs,
    reviews: reviews(),
    companies: company,
    family: { check },
    subBrandLimit: 20,
  });
  const result = await service.check(store.runId, signal);
  expect(result.children).toHaveLength(20);
  expect(result.products).toBe(false);
  expect(company.link).toHaveBeenCalledTimes(20);
  const summary = await store.runs.step(store.runId, "family-summary");
  expect(summary).toMatchObject({
    subBrands: expect.arrayContaining([
      { name: "Brand 0", status: "skipped_not_nutrition" },
      { name: "Brand 22", status: "over_limit" },
    ]),
  });
  expect(company.link.mock.invocationCallOrder[0]).toBeLessThan(
    store.runs.create.mock.invocationCallOrder[1] ?? 0,
  );
});
it("shared-site lines resolve by name and are created without a website before products can run", async () => {
  const store = await seededRuns();
  const company = companies();
  const check = vi.fn(async () => ({
    ...family,
    shape: "shared_site" as const,
    subBrands: [
      {
        name: "Line",
        url: "https://example.test/line",
        isNutrition: true,
        evidence: { quote: "Our line", url: "https://example.test/brands" },
      },
    ],
  }));
  const result = await new BrandFamilyService({
    ...store,
    reviews: reviews(),
    companies: company,
    family: { check },
    subBrandLimit: 20,
  }).check(store.runId, signal);
  expect(company.resolve).toHaveBeenCalledWith({ name: "Line" }, signal);
  expect(company.resolveDomain).not.toHaveBeenCalled();
  expect(company.create).toHaveBeenCalledWith({ name: "Line", isNutrition: true }, signal);
  expect(result.products).toBe(true);
});
it("sub-brand runs never fan out", async () => {
  const store = await seededRuns("sub_brand");
  const check = vi.fn(async () => family);
  const result = await new BrandFamilyService({
    ...store,
    reviews: reviews(),
    companies: companies(),
    family: { check },
    subBrandLimit: 20,
  }).check(store.runId, signal);
  expect(result).toEqual({ children: [], products: true });
  expect(check).not.toHaveBeenCalled();
});
