import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { AnalyzedBrandSchema } from "@crawl-automation/v3-contracts";
import { applySiteAnalysis } from "./site-analysis-apply.js";
import { enqueueAnalyzedBrands } from "./site-analysis-enqueue.js";
import { insertAnalyzedSettings, replaceAnalyzedSettings } from "./site-analysis-settings.js";

vi.mock("./site-analysis-settings.js", async (original) => ({
  ...(await original<typeof import("./site-analysis-settings.js")>()),
  conflictingCatalog: vi.fn(async () => null),
  singleBrandSite: vi.fn(async () => true),
  insertAnalyzedSettings: vi.fn(async () => true),
  replaceAnalyzedSettings: vi.fn(async () => ({ oldKind: "multi-brand", newKind: "single-brand" })),
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
  existing: string | false = false,
  analysis: { state?: "completed" | "needs-review"; reasons?: string[]; url?: string } = {},
) {
  const { state = "completed", reasons = [], url = "https://owner.example/" } = analysis;
  const sourceId = randomUUID();
  const brandId = randomUUID();
  const scanId = randomUUID();
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT state,brands")) {
      const limits = { maxBrands: 50, maxPages: 100, maxDomains: 50 };
      return [{ state, brands, limits, reasons, url }];
    }
    if (sql.startsWith("SELECT id FROM brand")) {
      return [{ id: brandId }];
    }
    if (sql.startsWith("SELECT id,channel,url FROM brand_source")) {
      return existing ? [{ id: sourceId, channel: "dtc", url: existing }] : [];
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

it("corrects only a matched source and reports the kind transition", async () => {
  const test = fixture(
    [brand("Owner", "https://owner.example/pages/shop")],
    "https://owner.example/pages/shop",
  );
  vi.mocked(replaceAnalyzedSettings).mockClear();
  const analysisId = randomUUID();
  const result = await applySiteAnalysis(test.tx, { analysisId, replaceSettings: true });
  expect(result.created).toEqual([]);
  expect(result.matched).toEqual([
    { name: "Owner", brandId: test.brandId, sourceId: test.sourceId },
  ]);
  expect(result.corrected).toEqual([
    {
      name: "Owner",
      brandId: test.brandId,
      sourceId: test.sourceId,
      oldKind: "multi-brand",
      newKind: "single-brand",
    },
  ]);
  expect(replaceAnalyzedSettings).toHaveBeenCalledWith(
    test.tx,
    expect.objectContaining({
      sourceId: test.sourceId,
      singleBrand: true,
    }),
  );
  expect(test.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO brand_source"))).toBe(
    false,
  );
  expect(test.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO brand ("))).toBe(false);
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
it("scans a home-page store's whole catalog, not the collection the analysis looked at", async () => {
  const test = fixture([brand("Owner", "https://owner.example/collections/pre-workout")]);
  vi.mocked(insertAnalyzedSettings).mockClear();
  await applySiteAnalysis(test.tx, { analysisId: randomUUID() });
  expect(insertAnalyzedSettings).toHaveBeenCalledWith(
    test.tx,
    expect.objectContaining({
      brand: expect.objectContaining({ catalogUrl: "https://owner.example/collections/all" }),
    }),
  );
});

it("keeps a submitted collection as the catalog", async () => {
  const submitted = "https://owner.example/collections/pre-workout";
  const test = fixture([brand("Owner", submitted)], false, { url: submitted });
  vi.mocked(insertAnalyzedSettings).mockClear();
  await applySiteAnalysis(test.tx, { analysisId: randomUUID() });
  expect(insertAnalyzedSettings).toHaveBeenCalledWith(
    test.tx,
    expect.objectContaining({ brand: expect.objectContaining({ catalogUrl: submitted }) }),
  );
});

it("moves a source stored at the observed collection to the whole store on correction", async () => {
  const observed = "https://owner.example/collections/pre-workout";
  const test = fixture([brand("Owner", observed)], observed);
  const result = await applySiteAnalysis(test.tx, {
    analysisId: randomUUID(),
    replaceSettings: true,
  });
  expect(result.matched).toEqual([
    { name: "Owner", brandId: test.brandId, sourceId: test.sourceId },
  ]);
  expect(test.query).toHaveBeenCalledWith("UPDATE brand_source SET url=$2 WHERE id=$1", [
    test.sourceId,
    "https://owner.example/collections/all",
  ]);
});

it("applies verified brands and reports an explicitly selected unverified brand", async () => {
  const unverified = {
    ...brand("Dherbs Active", "https://dherbsactive.example/store/"),
    domain: "dherbsactive.example",
    status: "needs-review" as const,
    reason: "TLS failure",
  };
  const test = fixture([brand("Dherbs", "https://owner.example/store/"), unverified], false, {
    state: "needs-review",
    reasons: ["BRAND_VERIFICATION_INCOMPLETE"],
  });
  const result = await applySiteAnalysis(test.tx, {
    analysisId: randomUUID(),
    brands: ["Dherbs", "Dherbs Active"],
  });
  expect(result.created.map(({ name }) => name)).toEqual(["Dherbs"]);
  expect(result.skipped).toEqual([
    { name: "Dherbs Active", reason: "Brand not verified in this analysis: TLS failure" },
  ]);
  expect(
    test.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO brand_source")),
  ).toHaveLength(1);
});
it("refuses a capped needs-review analysis before touching brand sources", async () => {
  const test = fixture([brand("Dherbs", "https://owner.example/store/")], false, {
    state: "needs-review",
    reasons: ["Sub-brand domain cap exceeded; nothing may be applied"],
  });
  await expect(applySiteAnalysis(test.tx, { analysisId: randomUUID() })).rejects.toMatchObject({
    code: "SITE_ANALYSIS.NOT_APPLICABLE",
  });
  expect(test.query).toHaveBeenCalledOnce();
});
