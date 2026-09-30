import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { loadSqlCatalog } from "../migrations/sql-catalog.js";
import { PostgresBrandScans } from "./postgres-brand-scans.js";
import { scanOf } from "./brand-scan-queries.js";

interface TemporaryPostgres {
  database: Database;
  stop(): Promise<void>;
}

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const runPostgres = hasPostgres && process.env["V3_TEST_POSTGRES"] === "1";

const result: ScanResult = {
  state: "partial",
  pages: 7,
  products: 168,
  families: 0,
  unresolvedFamilies: 0,
  statedTotal: 341,
  full: false,
  capped: true,
  newListings: 168,
  knownListings: 0,
  missing: 0,
  queued: 168,
  credits: 35,
  code: null,
};

it("automatically discovers and hashes 032 after 031 in the release catalog", async () => {
  const directory = fileURLToPath(new URL("../../../../database/v3/", import.meta.url));
  const catalog = await loadSqlCatalog(directory);
  expect(catalog[30]?.name).toBe("031_history_grants.sql");
  expect(catalog[31]?.name).toBe("032_brand_scan_amazon.sql");
  expect(catalog[31]?.sha256).toMatch(/^[a-f0-9]{64}$/);
});

it.each([true, undefined])(
  "reads capped=%s without requiring it on historical results",
  (capped) => {
    const row = {
      scanId: "scan",
      requestId: "request",
      revisitBatchId: "revisits",
      sourceId: "source",
      brandId: "brand",
      brandName: "Herb Pharm",
      channel: "amazon",
      url: "https://www.amazon.com/s",
      enabled: true,
      state: "partial",
      result: { ...result, capped },
      requestedAt: "now",
      startedAt: "now",
      finishedAt: "now",
    };
    expect(scanOf(row).result?.capped).toBe(capped);
  },
);

describe.skipIf(!runPostgres)(
  runPostgres
    ? "Amazon brand scans on temporary Unix-socket PostgreSQL"
    : "SKIPPED: set V3_TEST_POSTGRES=1 with local initdb/pg_ctl to test the Amazon migration",
  () => {
    let postgres: TemporaryPostgres | undefined;
    let scans: PostgresBrandScans;
    let sourceId: string;
    beforeAll(async () => {
      // Keep the integration helper's pg dependency outside ordinary unit-test collection.
      const { startTemporaryPostgres } = await vi.importActual<{
        startTemporaryPostgres(): Promise<TemporaryPostgres>;
      }>("../../integration/temporary-postgres.js");
      postgres = await startTemporaryPostgres();
      scans = new PostgresBrandScans(postgres.database);
      const [brand] = await postgres.database.query<{ id: string }>(
        "INSERT INTO brand (name) VALUES ('Amazon migration test') RETURNING id::text",
      );
      const [source] = await postgres.database.query<{ id: string }>(
        `INSERT INTO brand_source (brand_id, channel, url, enabled)
         VALUES ($1, 'amazon', 'https://www.amazon.com/s?rh=p_89%3ATest', true) RETURNING id::text`,
        [brand?.id],
      );
      sourceId = source?.id ?? "";
    }, 120_000);
    afterAll(async () => {
      await postgres?.stop();
    });

    it("accepts Amazon, preserves capped on read-back, and keeps finished scans immutable", async () => {
      const sources = await scans.sources([sourceId]);
      const requested = await scans.request("11111111-1111-4111-8111-111111111111", sources);
      const scanId = requested[0]?.scanId ?? "";
      expect(requested[0]?.source.channel).toBe("amazon");
      await scans.finish(scanId, result);
      expect((await scans.get(scanId))?.result).toEqual(result);
      expect(await scans.list({ channel: "amazon", limit: 1 })).toHaveLength(1);
      await expect(
        postgres?.database.query("UPDATE brand_scan SET result = '{}'::jsonb WHERE scan_id = $1", [
          scanId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("still refuses an unknown channel after widening the CHECK", async () => {
      await expect(
        postgres?.database.query(
          `INSERT INTO brand_scan (request_id, source_id, channel, url)
         VALUES ('22222222-2222-4222-8222-222222222222', $1, 'unknown', 'https://example.com/')`,
          [sourceId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  },
);
