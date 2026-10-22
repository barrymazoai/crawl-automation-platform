import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { AnalyzedBrandSchema } from "@crawl-automation/v3-contracts";
import { replaceAnalyzedSettings } from "./site-analysis-settings.js";

it("archives the locked old policy before updating a matched source", async () => {
  const sourceId = randomUUID();
  const analysisId = randomUUID();
  const catalogUrl = "https://optibio.example/pages/shop";
  const previous = {
    siteKey: "optibio.example",
    platform: "shopify",
    kind: "multi-brand",
    brands: [{ brand: "Optibio", catalogUrl }],
  };
  const query = vi.fn(async (sql: string, _params?: unknown[]) =>
    sql.startsWith("SELECT settings FROM dtc_source_settings") ? [{ settings: previous }] : [],
  );
  const input = {
    sourceId,
    analysisId,
    singleBrand: true,
    brand: AnalyzedBrandSchema.parse({
      name: "Optibio",
      domain: "optibio.example",
      platform: "shopify",
      catalogUrl,
      productCount: 1,
      countExact: false,
      wholeCatalog: false,
      discoveredFrom: { page: catalogUrl, link: catalogUrl },
      status: "verified",
      reason: null,
    }),
  };
  expect(await replaceAnalyzedSettings({ query } as unknown as Queryable, input)).toEqual({
    oldKind: "multi-brand",
    newKind: "single-brand",
  });
  const sql = query.mock.calls.map(([statement]) => statement);
  expect(sql).toHaveLength(3);
  expect(sql[0]).toContain("FOR UPDATE");
  expect(sql[1]).toContain("INSERT INTO dtc_source_settings_history");
  expect(sql[2]).toContain("UPDATE dtc_source_settings SET");
  expect(query.mock.calls[2]?.[1]).toEqual([
    sourceId,
    analysisId,
    JSON.stringify({
      siteKey: "optibio.example",
      platform: "shopify",
      kind: "single-brand",
      catalogUrl,
    }),
  ]);
});
