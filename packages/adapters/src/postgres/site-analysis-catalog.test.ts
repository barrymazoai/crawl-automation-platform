import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { AnalyzedBrandSchema } from "@crawl-automation/v3-contracts";
import { applySiteAnalysis } from "./site-analysis-apply.js";
import { enqueueAnalyzedBrands } from "./site-analysis-enqueue.js";
import { insertAnalyzedSettings } from "./site-analysis-settings.js";

vi.mock("./site-analysis-settings.js", async (original) => ({
  ...(await original<typeof import("./site-analysis-settings.js")>()),
  conflictingCatalog: vi.fn(async () => null),
  singleBrandSite: vi.fn(async () => true),
  insertAnalyzedSettings: vi.fn(async () => true),
}));

const catalogUrl = "https://owner.example/collections/absorbed";
const brand = (name: string, url: string) =>
  AnalyzedBrandSchema.parse({
    name,
    domain: "owner.example",
    platform: "shopify",
    catalogUrl: url,
    productCount: 1,
    countExact: false,
    wholeCatalog: false,
    discoveredFrom: { page: url, link: url },
    status: "verified",
    reason: null,
  });

function fixture(
  brands = [brand("Absorbed", catalogUrl), brand("Owner", "https://owner.example/collections/all")],
) {
  const sourceId = randomUUID();
  const brandId = randomUUID();
  const scanId = randomUUID();
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT state,brands")) {
      return [{ state: "completed", brands }];
    }
    if (sql.startsWith("SELECT id FROM brand")) {
      return [{ id: brandId }];
    }
    if (sql.startsWith("INSERT INTO brand_source")) {
      return [{ id: sourceId }];
    }
    if (sql.startsWith("INSERT INTO brand_scan")) {
      return [{ scan_id: scanId }];
    }
    return [];
  });
  return { query, tx: { query } as unknown as Queryable, sourceId, brandId, scanId };
}

it("applies and queues only the selected collection using the existing per-brand DTC policy", async () => {
  const test = fixture();
  vi.mocked(insertAnalyzedSettings).mockClear();
  const analysisId = randomUUID();
  const result = await applySiteAnalysis(test.tx, { analysisId, catalogUrl, enqueue: true });
  await enqueueAnalyzedBrands(test.tx, analysisId, result);
  expect(result.created).toEqual([
    { name: "Absorbed", brandId: test.brandId, sourceId: test.sourceId },
  ]);
  expect(result.skipped).toEqual([{ name: "Owner", reason: "Outside requested catalog" }]);
  expect(insertAnalyzedSettings).toHaveBeenCalledOnce();
  expect(insertAnalyzedSettings).toHaveBeenCalledWith(
    test.tx,
    expect.objectContaining({
      singleBrand: false,
      brand: expect.objectContaining({ name: "Absorbed", catalogUrl }),
    }),
  );
  expect(result.tasks).toEqual([{ ...result.created[0], scanId: test.scanId }]);
});

it("does not fall back to the whole store when the analysis has no matching collection", async () => {
  const test = fixture([brand("Owner", "https://owner.example/collections/all")]);
  const analysisId = randomUUID();
  const result = await applySiteAnalysis(test.tx, { analysisId, catalogUrl, enqueue: true });
  await enqueueAnalyzedBrands(test.tx, analysisId, result);
  expect(result.created).toEqual([]);
  expect(result.matched).toEqual([]);
  expect(result.tasks).toEqual([]);
  expect(test.query).toHaveBeenCalledOnce();
});

it("keeps unscoped single-brand apply behavior", async () => {
  const test = fixture([brand("Original", "https://owner.example/collections")]);
  vi.mocked(insertAnalyzedSettings).mockClear();
  await applySiteAnalysis(test.tx, { analysisId: randomUUID() });
  expect(insertAnalyzedSettings).toHaveBeenCalledWith(
    test.tx,
    expect.objectContaining({
      singleBrand: true,
      brand: expect.objectContaining({ catalogUrl: "https://owner.example/collections/all" }),
    }),
  );
});
