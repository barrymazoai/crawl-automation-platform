import { execFileSync } from "node:child_process";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresBrandScans } from "../src/postgres/postgres-brand-scans.js";
import { PostgresChannelQueueStore } from "../src/postgres/postgres-channel-queue-store.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

// Owner 2026-10-07 (CRAWLV3-213): scans start by source priority, a claim never exceeds its limit, and the caller's
// running scans are not taken over.
describe.skipIf(!hasPostgres)("brand scan priority against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let scans: PostgresBrandScans;
  const costco: string[] = [];
  const swanson: string[] = [];
  let gnc = "";

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    scans = new PostgresBrandScans(database);
    const [brand] = await database.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Priority Brand') RETURNING id",
    );
    const source = async (channel: string, url: string) => {
      const rows = await database.query<{ id: string }>(
        "INSERT INTO brand_source (brand_id, channel, url, enabled) VALUES ($1, $2, $3, true) RETURNING id",
        [brand?.id, channel, url],
      );
      return rows[0]?.id ?? "";
    };
    for (let index = 0; index < 6; index++) {
      costco.push(await source("costco", `https://www.costco.com/brand-${index}.html`));
    }
    for (let index = 0; index < 3; index++) {
      swanson.push(await source("swanson", `https://www.swansonvitamins.com/brand-${index}`));
    }
    gnc = await source("gnc", "https://www.gnc.com/brands/priority-brand/");
    await scans.request("11111111-1111-4111-8111-111111111111", await scans.sources(costco));
    await scans.request("33333333-3333-4333-8333-333333333333", await scans.sources(swanson));
    const [later] = await scans.sources([gnc]);
    await scans.request("22222222-2222-4222-8222-222222222222", later ? [later] : []);
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("gives Costco one slot and the other channels the rest, oldest first without a priority", async () => {
    const claimed = await scans.claim(2, 60_000);
    expect(claimed.map((scan) => scan.source.channel).sort()).toEqual([
      "costco",
      "swanson",
      "swanson",
    ]);
  });

  it("starts a prioritized source's scan before older ones", async () => {
    await new PostgresChannelQueueStore(database).setSourcePriority({
      channel: "gnc",
      sourceIds: [gnc],
      priority: 50,
    });
    const [next] = await scans.claim(1, 60_000);
    expect(next?.source.sourceId).toBe(gnc);
  });

  it("never takes over a scan the caller is still running", async () => {
    const running = await database.query<{ scan_id: string }>(
      "SELECT scan_id::text FROM brand_scan WHERE state = 'running'",
    );
    const active = running.map((row) => row.scan_id);
    // Every running row is stale with staleMs 0; only the ones not active may be taken over.
    await database.query(
      "UPDATE brand_scan SET started_at = now() - interval '1 hour' WHERE state = 'running'",
    );
    const claimed = await scans.claim(10, 0, active);
    expect(claimed.some((scan) => active.includes(scan.scanId))).toBe(false);
    // The last Swanson scan only: Costco has an active scan, so no second one is claimed.
    expect(claimed.map((scan) => scan.source.channel)).toEqual(["swanson"]);
  });
});
