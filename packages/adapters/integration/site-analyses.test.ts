import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SiteAnalysisLimitsSchema, type AnalyzedBrand } from "@crawl-automation/v3-contracts";
import { PostgresSiteAnalyses } from "../src/postgres/postgres-site-analyses.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

let postgres: TemporaryPostgres;
let store: PostgresSiteAnalyses;
beforeAll(async () => {
  postgres = await startTemporaryPostgres();
  store = new PostgresSiteAnalyses(postgres.database);
}, 60_000);
afterAll(async () => postgres?.stop());
const brand = (name: string): AnalyzedBrand => ({
  name,
  domain: "shop.example",
  platform: "shopify",
  catalogUrl: `https://shop.example/collections/vendors?q=${name}`,
  productCount: 2,
  countExact: true,
  wholeCatalog: false,
  discoveredFrom: "platform-data",
  status: "verified",
  reason: null,
});
async function completed(names: string[]) {
  const input = { requestId: randomUUID(), url: "https://shop.example/" };
  const created = await store.create(input, SiteAnalysisLimitsSchema.parse({}));
  expect(await store.create(input, SiteAnalysisLimitsSchema.parse({ maxBrands: 20 }))).toEqual(
    created,
  );
  await store.evidence(created.analysisId, "v3/original.html");
  await store.evidence(created.analysisId, "v3/original.html");
  await store.finish(created.analysisId, {
    state: "completed",
    brands: names.map(brand),
    archiveKeys: ["v3/original.html"],
    reasons: [],
  });
  return created.analysisId;
}
it("two vendor brands become two sources once, with usable persisted policies and no overwrites", async () => {
  const analysisId = await completed(["Alpha", "Beta"]);
  const input = { requestId: randomUUID(), analysisId };
  const result = await store.apply(input);
  expect(result.created).toHaveLength(2);
  expect(await store.apply(input)).toEqual(result);
  const again = await store.apply({ ...input, requestId: randomUUID() });
  expect(again.created).toHaveLength(0);
  expect(again.matched).toHaveLength(2);
  const rows = await postgres.database.query<{ url: string; enabled: boolean; revision: number }>(
    "SELECT url,enabled,revision FROM brand_source ORDER BY url",
  );
  expect(rows.map((row) => row.url)).toEqual([brand("Alpha").catalogUrl, brand("Beta").catalogUrl]);
  expect(rows.every((row) => row.enabled && row.revision === 1)).toBe(true);
  expect(await store.settings()).toHaveLength(2);
  expect((await store.get(analysisId))?.archiveKeys).toEqual(["v3/original.html"]);
});
it("different request IDs concurrently applying another analysis match the same sources", async () => {
  const analysisId = await completed(["Gamma"]);
  const results = await Promise.all(
    [1, 2].map(() => store.apply({ requestId: randomUUID(), analysisId })),
  );
  expect(results.flatMap((result) => result.created)).toHaveLength(1);
  expect(results.flatMap((result) => result.matched)).toHaveLength(1);
});
it("rejects applying a capped analysis in the transaction and refuses changed request input", async () => {
  const requestId = randomUUID();
  await store.create(
    { requestId, url: "https://shop.example/" },
    SiteAnalysisLimitsSchema.parse({ maxBrands: 1 }),
  );
  await store.finish(requestId, {
    state: "needs-review",
    brands: [brand("Overflow")],
    archiveKeys: [],
    reasons: ["cap"],
  });
  await expect(
    store.apply({ requestId: randomUUID(), analysisId: requestId }),
  ).rejects.toMatchObject({ code: "SITE_ANALYSIS.NOT_APPLICABLE" });
  await expect(
    store.create({ requestId, url: "https://other.example/" }, SiteAnalysisLimitsSchema.parse({})),
  ).rejects.toMatchObject({ code: "REQUEST.ID_CONFLICT" });
});
it("brand selection skips absent names and preserves an existing disabled source", async () => {
  const analysisId = await completed(["Alpha", "Beta"]);
  await postgres.database.query("UPDATE brand_source SET enabled=false WHERE url=$1", [
    brand("Alpha").catalogUrl,
  ]);
  const result = await store.apply({
    requestId: randomUUID(),
    analysisId,
    brands: ["Alpha", "Absent"],
  });
  expect(result.matched.map((entry) => entry.name)).toEqual(["Alpha"]);
  expect(result.skipped).toEqual([{ name: "Absent", reason: "Name not present in this analysis" }]);
  const rows = await postgres.database.query<{ enabled: boolean }>(
    "SELECT enabled FROM brand_source WHERE id=$1",
    [result.matched[0]?.sourceId],
  );
  expect(rows[0]?.enabled).toBe(false);
});
it("does not create another task for a brand/domain whose source uses a different catalog", async () => {
  const analysisId = await completed(["Alpha"]);
  await postgres.database.query(
    "UPDATE brand_source SET url='https://shop.example/collections/alpha-old' WHERE url=$1",
    [brand("Alpha").catalogUrl],
  );
  const result = await store.apply({ requestId: randomUUID(), analysisId });
  expect(result.created).toHaveLength(0);
  expect(result.skipped[0]?.reason).toContain("preserved unchanged");
});
it("applies a verified custom store with an agent capture policy and an observed partial count", async () => {
  const created = await store.create(
    { requestId: randomUUID(), url: "https://www.dherbs.com/" },
    SiteAnalysisLimitsSchema.parse({}),
  );
  await store.finish(created.analysisId, {
    state: "completed",
    brands: [
      {
        ...brand("Dherbs"),
        domain: "www.dherbs.com",
        platform: "custom",
        catalogUrl: "https://www.dherbs.com/store/",
        productCount: 27,
        countExact: false,
        wholeCatalog: false,
        discoveredFrom: { page: "https://www.dherbs.com/", link: "https://www.dherbs.com/store/" },
      },
    ],
    archiveKeys: [],
    reasons: [],
  });
  const applied = await store.apply({ requestId: randomUUID(), analysisId: created.analysisId });
  expect(applied.created).toHaveLength(1);
  expect(await store.settings()).toContainEqual({
    siteKey: "www.dherbs.com",
    platform: "custom",
    capture: "agent",
    kind: "single-brand",
    catalogUrl: "https://www.dherbs.com/store/",
  });
});
it("retains old settings while explicitly correcting a scoped Optibio-like source", async () => {
  const catalogUrl = "https://optibio.example/pages/shop";
  const created = await store.create(
    { requestId: randomUUID(), url: "https://optibio.example/" },
    SiteAnalysisLimitsSchema.parse({}),
  );
  await store.finish(created.analysisId, {
    state: "completed",
    brands: [{ ...brand("Optibio"), domain: "optibio.example", catalogUrl }],
    archiveKeys: [],
    reasons: [],
  });
  const first = await store.apply({
    requestId: randomUUID(),
    analysisId: created.analysisId,
    catalogUrl,
  });
  expect(first.created).toHaveLength(1);
  const sourceId = first.created[0]?.sourceId;
  const oldSettings = {
    siteKey: "optibio.example",
    platform: "shopify",
    kind: "multi-brand",
    brands: [{ brand: "Optibio", catalogUrl }],
  };
  expect(await store.settings()).toContainEqual(oldSettings);

  const unchanged = await store.apply({ requestId: randomUUID(), analysisId: created.analysisId });
  expect(unchanged.created).toHaveLength(0);
  expect(unchanged.skipped).toEqual([
    {
      name: "Optibio",
      reason: "Existing source settings conflict; preserved unchanged",
    },
  ]);
  expect(await store.settings()).toContainEqual(oldSettings);

  const corrected = await store.apply({
    requestId: randomUUID(),
    analysisId: created.analysisId,
    replaceSettings: true,
  });
  expect(corrected.created).toHaveLength(0);
  expect(corrected.matched[0]?.sourceId).toBe(sourceId);
  expect(corrected.corrected).toEqual([
    {
      name: "Optibio",
      brandId: first.created[0]?.brandId,
      sourceId,
      oldKind: "multi-brand",
      newKind: "single-brand",
    },
  ]);
  expect(await store.settings()).toContainEqual({
    siteKey: "optibio.example",
    platform: "shopify",
    kind: "single-brand",
    catalogUrl,
  });
  const history = await postgres.database.query<{
    source_id: string;
    analysis_id: string;
    settings: unknown;
    replaced_by_analysis_id: string;
    reason: string;
    replaced_at: Date;
  }>(
    "SELECT source_id,analysis_id,settings,replaced_by_analysis_id,reason,replaced_at FROM dtc_source_settings_history WHERE source_id=$1",
    [sourceId],
  );
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    source_id: sourceId,
    analysis_id: created.analysisId,
    settings: oldSettings,
    replaced_by_analysis_id: created.analysisId,
    reason: "owner-approved analysis reapply",
  });
  expect(history[0]?.replaced_at).toBeInstanceOf(Date);
  expect(
    await postgres.database.query("SELECT id FROM brand_source WHERE id=$1", [sourceId]),
  ).toHaveLength(1);
  const again = await store.apply({
    requestId: randomUUID(),
    analysisId: created.analysisId,
    replaceSettings: true,
  });
  expect(again.corrected).toEqual([]);
  expect(
    await postgres.database.query("SELECT id FROM dtc_source_settings_history WHERE source_id=$1", [
      sourceId,
    ]),
  ).toHaveLength(1);
});
