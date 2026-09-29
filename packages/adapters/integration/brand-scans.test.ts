import { execFileSync } from "node:child_process";
import { AddToQueueSchema, type ScanResult } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresBrandScans } from "../src/postgres/postgres-brand-scans.js";
import { PostgresBrandSourceImport } from "../src/postgres/postgres-brand-source-import.js";
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

const requestId = "66666666-6666-4666-8666-666666666666";
const earlierList = "77777777-7777-4777-8777-777777777777";

const result: ScanResult = {
  state: "complete",
  pages: 1,
  products: 1,
  families: 0,
  unresolvedFamilies: 0,
  statedTotal: 1,
  full: true,
  missing: 1,
  queued: 1,
  credits: 10,
  code: null,
};

describe.skipIf(!hasPostgres)("brand scans against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let scans: PostgresBrandScans;
  let sourceId: string;

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    scans = new PostgresBrandScans(database);
    const imports = new PostgresBrandSourceImport(database);
    await database.query("INSERT INTO brand (name) VALUES ('Nordic Naturals')");
    const [brand] = await imports.brandNames();
    const url = "https://www.gnc.com/brands/nordic-naturals/";
    expect(
      await imports.addDisabledSources([{ brandId: brand?.brandId ?? "", channel: "gnc", url }]),
    ).toEqual({
      created: 1,
      existing: 0,
    });
    expect(
      await imports.addDisabledSources([{ brandId: brand?.brandId ?? "", channel: "gnc", url }]),
    ).toEqual({
      created: 0,
      existing: 1,
    });
    const rows = await database.query<{ id: string; enabled: boolean }>(
      "SELECT id::text AS id, enabled FROM brand_source",
    );
    expect(rows).toEqual([expect.objectContaining({ enabled: false })]);
    sourceId = rows[0]?.id ?? "";
    await database.query("UPDATE brand_source SET enabled = true WHERE id = $1", [sourceId]);
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("starts each source's scan once per request, claims it, and keeps the finished result unchangeable", async () => {
    const [source] = await scans.enabledSources("gnc");
    expect(source).toMatchObject({ brandName: "Nordic Naturals", enabled: true });
    const first = await scans.request(requestId, source ? [source] : []);
    const again = await scans.request(requestId, source ? [source] : []);
    expect(again.map((scan) => scan.scanId)).toEqual(first.map((scan) => scan.scanId));
    const [claimed] = await scans.claim(4, 60_000);
    expect(claimed).toMatchObject({ scanId: first[0]?.scanId, state: "running" });
    expect(await scans.claim(4, 60_000)).toEqual([]);
    await scans.finish(claimed?.scanId ?? "", result);
    await scans.finish(claimed?.scanId ?? "", {
      ...result,
      state: "review",
      code: "BRAND_SCAN.URL",
    });
    expect(await scans.list({ channel: "gnc", limit: 10 })).toEqual([
      expect.objectContaining({ state: "complete", result }),
    ]);
  });

  it("knows the source's listings from earlier lists, not from the scan's own list", async () => {
    const queue = new PostgresChannelQueueStore(database);
    const [scan] = await scans.list({ channel: "gnc", limit: 1 });
    const product = (listingId: string) => ({
      sourceId,
      url: `https://www.gnc.com/omega/${listingId}.html`,
      listingId,
    });
    const add = (batchId: string, ids: string[]) =>
      queue.add(
        AddToQueueSchema.parse({
          channel: "gnc",
          batchId,
          label: "test",
          products: ids.map(product),
        }),
      );
    await add(earlierList, ["877080", "877081"]);
    await add(scan?.scanId ?? "", ["877082"]);
    const [source] = await scans.sources([sourceId]);
    if (!scan || !source) {
      throw new Error("the scan and its source exist");
    }
    const known = await scans.knownListings(source, scan.scanId);
    expect(known.map((item) => item.listingId)).toEqual(["877080", "877081"]);
  });
});
